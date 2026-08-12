import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReaderEpub } from '../unit/epub-fixture'
import { installBooks, launchApp } from './helpers'

/**
 * Reader proof of concept end to end: a real EPUB is ingested, opened from
 * the library, paginated, and its progress restored across sessions.
 */

let dataDir: string
let booksDir: string

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  return launchApp(dataDir)
}

async function openBook(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Search' }).click()
  await page.locator('.search-input').fill('Reader Fixture')
  const card = page.getByRole('gridcell', { name: /Reader Fixture/ })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await card.click()
  await page.waitForSelector('.reader-screen')
}

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'liseur-e2e-reader-'))
  booksDir = mkdtempSync(join(tmpdir(), 'liseur-e2e-reader-books-'))

  // Phase 1: let the app create its database, then register the folder.
  await installBooks(dataDir, booksDir, {
    // words:2000 gives several pages per chapter — enough room to turn
    // pages repeatedly without reaching the true end of the book (reaching
    // it is real reading activity too, and marks the book finished, which
    // would hide it from Continue Reading; that is covered separately in
    // reader-worker.test.ts).
    'reader.epub': buildReaderEpub({ chapters: 3, words: 2000 }),
    'second.epub': buildReaderEpub({ chapters: 3, words: 2000, title: 'Second Tome' }),
  })
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
    // so a few turns cross into chapter 2). Deliberately short of the book's
    // end: reaching it is real reading activity too, and marks the book
    // finished (a separate, correctly persisted concern — see
    // reader-worker.test.ts) which would hide it from Continue Reading.
    const before = await page.locator('.reader-footer').textContent()
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
    await expect
      .poll(() => page.locator('.reader-footer').textContent(), { timeout: 10_000 })
      .not.toBe(before)

    // TOC navigation works.
    await page.getByRole('button', { name: 'Table of contents' }).click()
    await page.getByRole('button', { name: 'Chapter 3' }).click()
    await expect(iframe.locator('h1')).toHaveText('Chapter 3', { timeout: 10_000 })
    await expect(page.locator('.reader-footer')).toContainText('Chapter 3')
    // TOC navigation is user-originated: it publishes immediately (no
    // debounce), so the close-time handshake below persists this exact
    // position without needing to wait for it to land first.
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

test('the banner follows you to the book you just opened', async () => {
  // Opening a book and going straight back out — the wrong book, or a
  // glance at the first page — left the PREVIOUS book on the Continue
  // Reading banner. The banner only knew about books with a saved reading
  // position, and a book closed before it finished loading never saves one.
  const { app, page } = await launch()
  try {
    await page.getByRole('button', { name: 'Search' }).click()
    await page.locator('.search-input').fill('Second Tome')
    const card = page.getByRole('gridcell', { name: /Second Tome/ })
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()
    // Straight back out, before the book has even finished opening — the
    // "wrong book" case. Nothing is saved for a book closed this early, so
    // a banner that goes by saved positions alone stays on the old book.
    await page.keyboard.press('Escape')
    await page.waitForSelector('.library-screen')
    await page.getByRole('button', { name: 'Search' }).click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    const banner = page.locator('.continue-reading')
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(banner.locator('.continue-title')).toHaveText('Second Tome')
  } finally {
    await app.close()
  }
})
