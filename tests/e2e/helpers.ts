import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

export async function launchApp(
  dataDir: string,
): Promise<{ app: ElectronApplication; page: Page }> {
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
  const { app } = await launchApp(dataDir)
  await app.close()
  writeFileSync(join(booksDir, filename), epub)
  const db = new DatabaseSync(join(dataDir, 'liseur.db'))
  db.prepare('INSERT OR IGNORE INTO folders (id, path, added_at) VALUES (?, ?, ?)').run(
    `folder-${booksDir}`,
    booksDir,
    Date.now(),
  )
  db.close()
}

/** Opens a book from the library by title via search + double-click. */
export async function openBookByTitle(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Search' }).click()
  await page.locator('.search-input').fill(title)
  const card = page.getByRole('gridcell', { name: new RegExp(title) })
  await card.waitFor({ timeout: 10_000 })
  await card.dblclick()
  await page.waitForSelector('.reader-screen')
}

/** Reader chrome auto-hides when idle; a pointer move reveals it. */
export async function revealChrome(page: Page): Promise<void> {
  await page.mouse.move(400, 300)
  await page.mouse.move(400, 301)
}
