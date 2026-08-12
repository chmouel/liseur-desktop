import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Shared e2e plumbing: hermetic per-suite data dirs and the two-phase
 * "register a folder, relaunch, startup rescan ingests" flow (native open
 * dialogs can't be automated).
 */

export function makeTempDirs(): { dataDir: string; booksDir: string } {
  return {
    dataDir: mkdtempSync(join(tmpdir(), 'liseur-e2e-data-')),
    booksDir: mkdtempSync(join(tmpdir(), 'liseur-e2e-books-')),
  }
}

/**
 * Every test gets the same window, whatever the screen behind it. Layout
 * assertions (columns, measure caps) depend on how much room the reader has,
 * and a CI screen is smaller than a desk one.
 */
const WINDOW = { width: 1600, height: 1000 }

export async function launchApp(
  dataDir: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  // Seed the size before the window exists: resizing a live window makes it
  // move under Playwright's feet and clicks never find a stable target.
  mkdirSync(dataDir, { recursive: true })
  const stateFile = join(dataDir, 'window-state.json')
  const state = existsSync(stateFile)
    ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>)
    : {}
  writeFileSync(stateFile, JSON.stringify({ ...state, window: { ...WINDOW, x: 0, y: 0 } }))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, NODE_ENV: 'test', LISEUR_DATA_DIR: dataDir },
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.library-screen')
  return { app, page }
}

/**
 * Phase 1: create the app's database; register `booksDir` as a folder with
 * `epub` written inside; the next launch's startup rescan ingests it.
 */
export async function installBook(
  dataDir: string,
  booksDir: string,
  filename: string,
  epub: Buffer,
): Promise<void> {
  await installBooks(dataDir, booksDir, { [filename]: epub })
}

/** As `installBook`, for a folder that starts with several books in it. */
export async function installBooks(
  dataDir: string,
  booksDir: string,
  epubs: Record<string, Buffer>,
): Promise<void> {
  const { app } = await launchApp(dataDir)
  // The library screen paints before the worker has finished preparing the
  // database, so wait for the table we are about to write to. The worker may
  // be holding the write lock while it does, hence the tolerance for a busy
  // file: the next attempt is 100 ms away.
  const dbPath = join(dataDir, 'liseur.db')
  const hasSchema = (): boolean => {
    if (!existsSync(dbPath)) return false
    let probe: DatabaseSync | undefined
    try {
      probe = new DatabaseSync(dbPath, { readOnly: true })
      return (
        probe
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
          .get() !== undefined
      )
    } catch {
      return false
    } finally {
      probe?.close()
    }
  }
  const deadline = Date.now() + 20_000
  while (!hasSchema()) {
    if (Date.now() > deadline) throw new Error('the app never created its database')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await app.close()
  for (const [filename, epub] of Object.entries(epubs)) {
    writeFileSync(join(booksDir, filename), epub)
  }
  // The app has gone but its file handles may take a moment to follow.
  const writeDeadline = Date.now() + 10_000
  for (;;) {
    try {
      const db = new DatabaseSync(dbPath)
      db.prepare('INSERT OR IGNORE INTO folders (id, path, added_at) VALUES (?, ?, ?)').run(
        `folder-${booksDir}`,
        booksDir,
        Date.now(),
      )
      db.close()
      return
    } catch (error) {
      if (Date.now() > writeDeadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

/** Opens a book from the library by title via search + double-click. */
export async function openBookByTitle(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Search' }).click()
  await page.locator('.search-input').fill(title)
  const card = page.getByRole('gridcell', { name: new RegExp(title) })
  await card.waitFor({ timeout: 10_000 })
  await card.click()
  await page.waitForSelector('.reader-screen')
}

/** Reader chrome auto-hides when idle; a pointer move reveals it. */
export async function revealChrome(page: Page): Promise<void> {
  await page.mouse.move(400, 300)
  await page.mouse.move(400, 301)
}
