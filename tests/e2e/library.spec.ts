import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * End-to-end smoke tests against the production build (run `pnpm build`
 * first; CI does). Electron tests run with workers=1 (see config).
 *
 * Each run gets a throwaway data directory and explicitly asks for the
 * deterministic 10,000-book dataset — the app itself never seeds it, so the
 * request has to be made here. The tests never touch the developer's real
 * library.
 */

let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'liseur-e2e-'))
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LISEUR_DATA_DIR: dataDir,
      LISEUR_SEED_FAKE_LIBRARY: '1',
    },
  })
  page = await app.firstWindow()
  await page.waitForSelector('.library-screen')
})

test.afterAll(async () => {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('launches and renders the library shell', async () => {
  await expect(page.locator('.brand-name')).toHaveText('Liseur')
  await expect(page.locator('.book-card').first()).toBeVisible()
})

test('the top bar carries the brand tile and the size of the shelf', async () => {
  // The reading-scene art, matching the Android app's top bar. It must
  // actually decode: a broken import still lays out as an <img>.
  const decoded = await page.locator('.brand-tile').evaluate((el) => {
    const img = el as HTMLImageElement
    return img.complete && img.naturalWidth > 0
  })
  expect(decoded).toBe(true)

  // The count follows the filter, as it does on Android: it says how big
  // the shelf you are looking at is, not how many rows the database holds.
  await expect(page.locator('.brand-count')).toHaveText(/^[\d,]+ books$/)
  const all = await page.locator('.brand-count').textContent()
  await page.getByRole('tab', { name: 'Unread' }).click()
  await expect.poll(() => page.locator('.brand-count').textContent()).not.toBe(all)
  await page.getByRole('tab', { name: 'All' }).click()
  await expect(page.locator('.brand-count')).toHaveText(all!)

  // The bar is a banner, not a strip: the art is big enough to read as a
  // picture and the wordmark big enough to read across a desk.
  const tile = await page.locator('.brand-tile').evaluate((el) => el.getBoundingClientRect().height)
  expect(tile).toBeGreaterThanOrEqual(64)
  const name = await page
    .locator('.brand-name')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  expect(name).toBeGreaterThanOrEqual(30)

  const centers = await page.evaluate(() => {
    const name = document.querySelector('.brand-name')?.getBoundingClientRect()
    const count = document.querySelector('.brand-count')?.getBoundingClientRect()
    return [name && name.left + name.width / 2, count && count.left + count.width / 2]
  })
  expect(centers[0]).toBeCloseTo(centers[1]!, 0)
})

test('the brand mark takes you back to the top of the shelf', async () => {
  const scroll = page.locator('.book-grid-scroll')
  await scroll.evaluate((el) => el.scrollTo({ top: 4000 }))
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await page.locator('.brand').click()
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0)
})

test('the continue-reading banner scrolls away with the shelf', async () => {
  // The banner is part of the shelf, not chrome pinned above it: scrolling
  // the grid carries it off screen instead of leaving it eating height.
  const banner = page.locator('.continue-reading')
  const scroll = page.locator('.book-grid-scroll')
  await expect(banner).toBeVisible()
  await scroll.evaluate((el) => el.scrollTo({ top: 4000 }))
  await expect(banner).not.toBeInViewport()
  // Rows still start where they should once the banner has gone by.
  await expect(page.locator('.book-card').first()).toBeVisible()
  await page.locator('.brand').click()
  await expect(banner).toBeInViewport()
})

test('the light continue-reading banner uses paper with a subtle cover wash', async () => {
  const themeToggle = page.getByRole('button', { name: 'Toggle theme' })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const theme = await page.evaluate(() => document.documentElement.dataset.theme)
    if (theme === 'light') break
    await themeToggle.click()
  }

  const banner = page.locator('.continue-reading')
  await expect(banner).toHaveCSS('background-image', /linear-gradient/)
  await expect(banner).toHaveCSS('backdrop-filter', 'none')
  await expect(banner.locator('.continue-bg')).toHaveCSS('filter', /blur\(32px\).*saturate\(0\.8\)/)
  await expect(banner.locator('.continue-bg')).toHaveCSS('opacity', '0.14')
})

test('the continue-reading banner and book columns span the shelf', async () => {
  const boxes = await page.evaluate(() => {
    const banner = document.querySelector('.continue-reading')
    const grid = document.querySelector('.book-grid')
    const lastCard = document.querySelector('.book-grid .book-card:last-child')
    return [banner, grid, lastCard].map((element) => element?.getBoundingClientRect())
  })
  expect(boxes[0]?.width).toBe(boxes[1]?.width)
  expect(boxes[0]?.right).toBeCloseTo(boxes[2]?.right ?? Number.NaN, 0)
})

test('renderer has no Node access', async () => {
  const [hasNode, hasApi] = await page.evaluate(() => [
    'process' in globalThis || 'require' in globalThis,
    typeof (globalThis as Record<string, unknown>).liseur === 'object',
  ])
  expect(hasNode).toBe(false)
  expect(hasApi).toBe(true)
})

test('search input updates immediately and filters results', async () => {
  await page.getByRole('button', { name: 'Search' }).click()
  const input = page.locator('.search-input')
  await expect(input).toBeFocused()

  const firstTitle = await page.locator('.book-title').first().textContent()
  await input.fill('glass')
  // Input reflects text on the same frame; results arrive asynchronously.
  await expect(input).toHaveValue('glass')
  await expect.poll(() => page.locator('.book-title').first().textContent()).not.toBe(firstTitle)
  await expect(page.locator('.book-title').first()).toContainText(/glass/i)

  await input.press('Escape') // clears query
  await expect(input).toHaveValue('')
  await input.press('Escape') // closes search
  await expect(input).not.toBeVisible()
})

test('filters switch the visible set', async () => {
  const allTitle = await page.locator('.book-title').first().textContent()
  // Archived books are excluded from every other filter, so the drawer
  // always holds a different first book than All.
  await page.getByRole('tab', { name: 'Archived' }).click()
  await expect.poll(() => page.locator('.book-title').first().textContent()).not.toBe(allTitle)
  await expect(page.getByRole('tab', { name: 'Archived' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'All' }).click()
})

test('the downloaded chip stays off until a server is configured', async () => {
  // With local files alone every book is downloaded and the chip selects
  // everything, so it is left off rather than shown inert.
  await expect(page.getByRole('tab', { name: 'Downloaded' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'All' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Unread' })).toBeVisible()
})

test('sorting by title reorders the grid', async () => {
  const firstTitle = await page.locator('.book-title').first().textContent()
  await page.locator('.sort-trigger').click()
  await page.getByRole('menuitem', { name: /^Title/ }).click()
  await expect.poll(() => page.locator('.book-title').first().textContent()).not.toBe(firstTitle)
  await expect(page.locator('.sort-trigger')).toContainText('Title')

  // Choosing the order you are already in turns it around rather than
  // doing nothing.
  const ascending = await page.locator('.book-title').first().textContent()
  await page.locator('.sort-trigger').click()
  await page.getByRole('menuitem', { name: /^Title/ }).click()
  await expect.poll(() => page.locator('.book-title').first().textContent()).not.toBe(ascending)

  await page.locator('.sort-trigger').click()
  await page.getByRole('menuitem', { name: 'Recent', exact: true }).click()
})

test('keyboard navigation moves selection', async () => {
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.book-card.selected')).toHaveCount(1)
  await page.keyboard.press('ArrowRight')
  const selected = await page.locator('.book-card.selected').first().getAttribute('aria-label')
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.book-card.selected')).not.toHaveAttribute('aria-label', selected!)
})

test('perf: 10,000-book library is virtualized and fast', async () => {
  // Never mount the full dataset: only visible + overscan rows exist.
  const cardCount = await page.locator('.book-card').count()
  expect(cardCount).toBeLessThan(500)

  // Smooth scroll: jump to the middle, rendered set must change without
  // ever materializing thousands of nodes.
  const before = await page.locator('.book-card').first().getAttribute('aria-label')
  await page.locator('.book-grid-scroll').evaluate((el) => (el.scrollTop = 100_000))
  await expect
    .poll(() => page.locator('.book-card').first().getAttribute('aria-label'))
    .not.toBe(before)
  expect(await page.locator('.book-card').count()).toBeLessThan(500)

  // Search round-trip latency (typed local input + worker query).
  const start = Date.now()
  await page.getByRole('button', { name: 'Search' }).click()
  await page.locator('.search-input').fill('winter')
  await expect(page.locator('.book-title').first()).toContainText(/winter/i)
  const elapsed = Date.now() - start
  console.log(`search round-trip: ${elapsed}ms`)
  expect(elapsed).toBeLessThan(2000) // generous CI bound; dev machines show <100ms
})

test('the menu bar stays out of the way until Alt asks for it', async () => {
  // Everything in the menu has a keyboard shortcut, so the strip of chrome
  // above the shelf is hidden until it is wanted. macOS keeps its menu in
  // the system bar and is not affected either way.
  const bar = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    return { autoHide: win.autoHideMenuBar, visible: win.isMenuBarVisible() }
  })
  expect(bar.autoHide).toBe(true)
  if (process.platform !== 'darwin') expect(bar.visible).toBe(false)
})

test('the menu keeps its accelerators while it is hidden', async () => {
  // A hidden menu that no longer answers to Ctrl+, would just be a missing
  // feature. The item still exists and still carries its shortcut.
  const settings = await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()
      ?.items.find((i) => i.label === 'File')
      ?.submenu?.items.find((i) => i.label.startsWith('Settings'))
    return { found: item !== undefined, accelerator: item?.accelerator }
  })
  expect(settings.found).toBe(true)
  expect(settings.accelerator).toBe('CmdOrCtrl+,')
})
