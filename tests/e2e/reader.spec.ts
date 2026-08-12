import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildReaderEpub } from '../unit/epub-fixture'

/**
 * Reader proof of concept end to end: a real EPUB is ingested, opened from
 * the library, paginated, and its progress restored across sessions.
 */

let dataDir: string
let booksDir: string

async function launch(): Promise<{
  app: ElectronApplication
  page: Page
}> {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, NODE_ENV: 'test', LISEUR_DATA_DIR: dataDir },
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.library-screen')
  return { app, page }
}

async function openBook(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Search' }).click()
  await page.locator('.search-input').fill('Reader Fixture')
  const card = page.getByRole('gridcell', { name: /Reader Fixture/ })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.dblclick()
  await page.waitForSelector('.reader-screen')
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'liseur-e2e-reader-'))
  booksDir = mkdtempSync(join(tmpdir(), 'liseur-e2e-reader-books-'))

  // Phase 1: let the app create its database, then register the folder.
  const { app } = await launch()
  await app.close()
  writeFileSync(join(booksDir, 'reader.epub'), buildReaderEpub({ chapters: 3 }))
  const db = new DatabaseSync(join(dataDir, 'liseur.db'))
  db.prepare('INSERT INTO folders (id, path, added_at) VALUES (?, ?, ?)').run(
    'reader-folder',
    booksDir,
    Date.now(),
  )
  db.close()
})

test.afterAll(async () => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(booksDir, { recursive: true, force: true })
})

test('opens, paginates, persists and restores progress', async () => {
  const { app, page } = await launch()
  try {
    await openBook(page)

    // Chapter rendered inside the sandboxed iframe.
    const iframe = page.frameLocator('.reader-iframe')
    await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 10_000 })
    await expect(page.locator('.reader-percent')).toContainText('%')

    // Turn pages until the position actually moves (chapter count is small,
    // so a few turns cross into chapter 2).
    const before = await page.locator('.reader-footer').textContent()
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight')
    await expect
      .poll(() => page.locator('.reader-footer').textContent(), { timeout: 10_000 })
      .not.toBe(before)

    // TOC navigation works.
    await page.getByRole('button', { name: 'Table of contents' }).click()
    await page.getByRole('button', { name: 'Chapter 3' }).click()
    await expect(iframe.locator('h1')).toHaveText('Chapter 3', { timeout: 10_000 })
    // Let the progress save (debounced 400ms) land before closing.
    await page.waitForTimeout(700)
    const atChapter3 = await page.locator('.reader-footer').textContent()

    // Close → Continue Reading shows the book; progress persisted.
    await page.keyboard.press('Escape')
    await page.waitForSelector('.library-screen')
    // The library search query survives close/reopen (by design); clear it
    // to reveal the Continue Reading card.
    await page.getByRole('button', { name: 'Search' }).click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const card = page.locator('.continue-reading')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.locator('.continue-title')).toHaveText('Reader Fixture')
    await expect(card.locator('.continue-percent')).not.toHaveText('0%')

    // It is the banner of the shelf, not a strip: a full-size cover and a
    // visible way back into the book.
    expect(
      await card.locator('.continue-cover').evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(180)
    await expect(card.locator('.continue-resume')).toBeVisible()

    // Reopen from the banner: restores the exact position persisted before
    // closing. Clicking the resume pill must reach the card underneath it.
    await card.locator('.continue-resume').click()
    await page.waitForSelector('.reader-screen')
    await expect(iframe.locator('h1')).toHaveText('Chapter 3', { timeout: 10_000 })
    await expect
      .poll(() => page.locator('.reader-footer').textContent(), { timeout: 10_000 })
      .toBe(atChapter3)
  } finally {
    await app.close()
  }
})
