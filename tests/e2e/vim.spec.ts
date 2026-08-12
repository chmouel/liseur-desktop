import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReaderEpub } from '../unit/epub-fixture'
import { installBook, launchApp, makeTempDirs, openBookByTitle } from './helpers'

/**
 * Vim mode: off unless asked for, additive when on.
 *
 * The point of the first test is the promise the feature makes to everyone
 * who did not ask for it — `j` must do nothing at all until the setting is
 * ticked.
 */

/** Writes the setting the way the app persists it, before it launches. */
function seedVimMode(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'window-state.json')
  const state = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { settings?: Record<string, unknown> })
    : {}
  writeFileSync(
    file,
    JSON.stringify({ ...state, settings: { ...(state.settings ?? {}), vimMode: true } }),
  )
}

test.describe('vim mode on the shelf', () => {
  let app: ElectronApplication
  let dataDir: string

  test.beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'liseur-e2e-vim-'))
    app = await electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LISEUR_DATA_DIR: dataDir,
        LISEUR_SEED_FAKE_LIBRARY: '1',
      },
    })
  })

  test.afterAll(async () => {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('stays out of the way until the setting is ticked, then answers', async () => {
    const page = await app.firstWindow()
    await page.waitForSelector('.library-screen')
    await page.locator('.book-card').first().waitFor()

    // Off by default: a letter key selects nothing.
    await page.keyboard.press('j')
    await expect(page.locator('.book-card.selected')).toHaveCount(0)

    await page.getByRole('button', { name: 'Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByLabel('Vim keys in the library and the reader').check()
    await page.keyboard.press('Escape')
    await expect(settings).not.toBeVisible()

    // On, without a restart.
    await page.keyboard.press('j')
    await expect(page.locator('.book-card.selected')).toHaveCount(1)
  })

  test('moves the selection, counts included', async () => {
    const page = await app.firstWindow()
    const selected = () =>
      page.locator('.book-card.selected').getAttribute('aria-label', { timeout: 5000 })

    await page.keyboard.press('g')
    await page.keyboard.press('g')
    const first = await selected()

    // 3l is three books to the right, and h comes back one.
    await page.keyboard.type('3l')
    const fourth = await selected()
    expect(fourth).not.toBe(first)
    await page.keyboard.press('h')
    const third = await selected()
    expect(third).not.toBe(fourth)

    // A half-typed sequence shows itself and Escape throws it away.
    await page.keyboard.press('2')
    await expect(page.locator('.vim-pending')).toHaveText('2')
    await page.keyboard.press('Escape')
    await expect(page.locator('.vim-pending')).toHaveCount(0)
    // Escape only cancelled the count: the selection is still there.
    expect(await selected()).toBe(third)

    // gg goes home again.
    await page.keyboard.press('g')
    await page.keyboard.press('g')
    expect(await selected()).toBe(first)

    // Arrows never stopped working.
    await page.keyboard.press('ArrowRight')
    expect(await selected()).not.toBe(first)
  })

  test('drives the shelf: filters, sorts, search and the key sheet', async () => {
    const page = await app.firstWindow()
    const activeChip = page.locator('.chip.active')
    const firstFilter = await activeChip.textContent()

    await page.keyboard.press('f')
    await expect(activeChip).not.toHaveText(firstFilter ?? '')
    await page.keyboard.press('F')
    await expect(activeChip).toHaveText(firstFilter ?? '')

    const sortLabel = page.locator('.sort-trigger')
    const firstSort = await sortLabel.textContent()
    await page.keyboard.press('s')
    await expect(sortLabel).not.toHaveText(firstSort ?? '')
    await page.keyboard.press('S')
    await expect(sortLabel).toHaveText(firstSort ?? '')

    // `?` lists every key there is — generated from the same table that
    // resolves them, so it cannot fall behind.
    await page.keyboard.press('?')
    const sheet = page.getByRole('dialog', { name: 'Vim keys' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText('First book', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).not.toBeVisible()

    // `/` opens search, and the field keeps the keyboard: `j` is a letter
    // again the moment there is somewhere to type it.
    await page.keyboard.press('/')
    const search = page.locator('.search-input')
    await expect(search).toBeFocused()
    await page.keyboard.type('jkl')
    await expect(search).toHaveValue('jkl')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
  })
})

test.describe('vim mode in a book', () => {
  let dataDir: string
  let booksDir: string
  let app: ElectronApplication | undefined

  test.beforeAll(async () => {
    ;({ dataDir, booksDir } = makeTempDirs())
    await installBook(dataDir, booksDir, 'vim.epub', buildReaderEpub({ chapters: 4, words: 600 }))
    seedVimMode(dataDir)
  })

  test.afterAll(async () => {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(booksDir, { recursive: true, force: true })
  })

  test('turns pages, walks chapters and leaves the book', async () => {
    test.setTimeout(60_000)
    ;({ app } = await launchApp(dataDir))
    const page = await app.firstWindow()
    await openBookByTitle(page, 'Reader Fixture')
    const iframe = page.frameLocator('.reader-iframe')
    await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 10_000 })

    // A page is a page: l goes forward, h comes back.
    const pageLabel = page.locator('.reader-chapter')
    await expect(pageLabel).toContainText('· 1/', { timeout: 10_000 })
    await page.keyboard.press('l')
    await expect(pageLabel).toContainText('· 2/')
    await page.keyboard.press('h')
    await expect(pageLabel).toContainText('· 1/')
    await page.keyboard.press('j')
    await expect(pageLabel).toContainText('· 2/')

    // A count before a chapter jump means chapters, not pages.
    await page.keyboard.type('2]]')
    await expect(iframe.locator('h1')).toHaveText('Chapter 3', { timeout: 10_000 })
    await page.keyboard.type('[[')
    await expect(iframe.locator('h1')).toHaveText('Chapter 2', { timeout: 10_000 })

    // The ends of the book.
    await page.keyboard.press('G')
    await expect(iframe.locator('h1')).toHaveText('Chapter 4', { timeout: 10_000 })
    await page.keyboard.press('g')
    await page.keyboard.press('g')
    await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 10_000 })

    // Panels: t is the contents, M the bookmarks, ? the key sheet.
    await page.keyboard.press('t')
    await expect(page.getByRole('navigation', { name: 'Table of contents' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('M')
    await expect(page.getByRole('dialog', { name: 'Bookmarks and notes' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('?')
    await expect(page.getByRole('dialog', { name: 'Vim keys' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Vim keys' })).not.toBeVisible()
    await expect(page.locator('.reader-screen')).toBeVisible()

    // m bookmarks the page it is on.
    await page.keyboard.press('m')
    await expect(page.getByRole('button', { name: 'Remove bookmark' })).toBeVisible()
    await page.keyboard.press('m')
    await expect(page.getByRole('button', { name: 'Bookmark this page' })).toBeVisible()

    // / searches, and the field keeps the keyboard.
    await page.keyboard.press('/')
    const search = page.locator('.book-search-input')
    await expect(search).toBeFocused()
    await page.keyboard.type('word2')
    await expect(search).toHaveValue('word2')
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)

    // q leaves the book, and so does Escape.
    await page.keyboard.press('q')
    await page.waitForSelector('.library-screen')
    await openBookByTitle(page, 'Reader Fixture')
    await expect(iframe.locator('h1')).toHaveText(/Chapter/, { timeout: 10_000 })
    await page.keyboard.press('Escape')
    await page.waitForSelector('.library-screen')
  })
})
