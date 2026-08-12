import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildEpub } from '../unit/epub-fixture'

/**
 * Folder ingestion end to end. Native open dialogs can't be automated, so
 * the test drives the other entry point — folders registered in the library
 * are rescanned at startup. Phase 1 lets the app create its database; the
 * test then registers a folder and drops in a real (synthetic) EPUB;
 * phase 2 verifies the startup rescan ingests it: card in the grid and a
 * cover served over the liseur-cover scheme.
 */

const env = (dataDir: string) => ({
  ...process.env,
  NODE_ENV: 'test',
  LISEUR_DATA_DIR: dataDir,
})

async function launch(dataDir: string): Promise<ElectronApplication> {
  const app = await electron.launch({ args: ['.'], env: env(dataDir) })
  const page = await app.firstWindow()
  await page.waitForSelector('.library-screen')
  return app
}

test('a fresh install opens onto an empty library', async () => {
  // The app used to fill any empty database with 10,000 generated books, so
  // a brand-new install — or a user who reset their data — was greeted by a
  // library full of titles that do not exist. The fake dataset is for
  // measuring the grid against its perf budget and must be asked for.
  const dataDir = mkdtempSync(join(tmpdir(), 'liseur-e2e-fresh-'))
  let app: ElectronApplication | undefined
  try {
    app = await launch(dataDir)
    const page = await app.firstWindow()
    await expect(page.locator('.empty-state')).toHaveText('No books here yet.')
    await expect(page.locator('.book-card')).toHaveCount(0)
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('startup folder rescan ingests a new EPUB', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'liseur-e2e-ingest-'))
  const booksDir = mkdtempSync(join(tmpdir(), 'liseur-e2e-books-'))
  let app: ElectronApplication | undefined
  try {
    // Phase 1: create the app's database (migrations only).
    app = await launch(dataDir)
    await app.close()

    // Register a folder and drop a real EPUB in it while the app is closed.
    writeFileSync(
      join(booksDir, 'e2e-tome.epub'),
      buildEpub({ title: 'The E2E Tome', creators: ['Play Wright'], identifier: 'e2e-tome-1' }),
    )
    const db = new DatabaseSync(join(dataDir, 'liseur.db'))
    db.prepare('INSERT INTO folders (id, path, added_at) VALUES (?, ?, ?)').run(
      'e2e-folder',
      booksDir,
      Date.now(),
    )
    db.close()

    // Phase 2: the startup rescan must ingest the book.
    app = await launch(dataDir)
    const page = await app.firstWindow()

    await page.getByRole('button', { name: 'Search' }).click()
    await page.locator('.search-input').fill('E2E Tome')

    const card = page.getByRole('gridcell', { name: 'The E2E Tome by Play Wright' })
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.locator('.book-title')).toHaveText('The E2E Tome')
    await expect(card.locator('.book-author')).toHaveText('Play Wright')
    await expect(card.locator('img.book-cover')).toHaveAttribute(
      'src',
      /^liseur-cover:\/\/cover\/[a-f0-9]{24}\.png$/,
    )
    // The cover actually renders (not just a well-formed URL).
    await expect
      .poll(async () =>
        card
          .locator('img.book-cover')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true)
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(booksDir, { recursive: true, force: true })
  }
})
