import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

/**
 * End-to-end smoke tests against the production build (run `pnpm build`
 * first; CI does). Electron tests run with workers=1 (see config).
 */

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, NODE_ENV: 'test' } })
  page = await app.firstWindow()
  await page.waitForSelector('.library-screen')
})

test.afterAll(async () => {
  await app.close()
})

test('launches and renders the library shell', async () => {
  await expect(page.locator('.brand-name')).toHaveText('Liseur')
  await expect(page.locator('.book-card').first()).toBeVisible()
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
  await page.getByRole('tab', { name: 'Downloaded' }).click()
  // Downloaded is a subset with a different first book than the default
  // "Recent" ordering of All.
  await expect.poll(() => page.locator('.book-title').first().textContent()).not.toBe(allTitle)
  await expect(page.getByRole('tab', { name: 'Downloaded' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.getByRole('tab', { name: 'All' }).click()
})

test('sorting by title reorders the grid', async () => {
  const firstTitle = await page.locator('.book-title').first().textContent()
  await page.getByRole('button', { name: /^Title/ }).click()
  await expect.poll(() => page.locator('.book-title').first().textContent()).not.toBe(firstTitle)
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

test('perf: 5000-book library is virtualized and fast', async () => {
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
