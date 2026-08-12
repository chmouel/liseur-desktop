import { test, expect, type ElectronApplication } from '@playwright/test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildEpub } from '../unit/epub-fixture'
import { installBook, launchApp, makeTempDirs } from './helpers'

/**
 * The reading statistics screen. Reading stretches are recorded as books are
 * read, which takes real time, so the test writes stretches straight into
 * the database between launches and checks the screen adds them up.
 */

function seedSessions(
  dataDir: string,
  rows: Array<{ id: string; bookId: string; startedAt: number; endedAt: number }>,
): void {
  const db = new DatabaseSync(join(dataDir, 'liseur.db'))
  const insert = db.prepare(
    'INSERT INTO reading_sessions (id, book_id, started_at, ended_at) VALUES (?,?,?,?)',
  )
  for (const row of rows) insert.run(row.id, row.bookId, row.startedAt, row.endedAt)
  db.close()
}

function bookIdOf(dataDir: string, title: string): string {
  const db = new DatabaseSync(join(dataDir, 'liseur.db'), { readOnly: true })
  const row = db.prepare('SELECT id FROM books WHERE title = ?').get(title) as
    { id: string } | undefined
  db.close()
  if (!row) throw new Error(`no book titled ${title}`)
  return row.id
}

test('reading statistics add up the time already read', async () => {
  const { dataDir, booksDir } = makeTempDirs()
  let app: ElectronApplication | undefined
  try {
    await installBook(dataDir, booksDir, 'stats.epub', buildEpub({ title: 'The Counted Book' }))

    // Phase 1: let the startup rescan ingest the book, then close.
    const first = await launchApp(dataDir)
    await first.page.getByRole('gridcell', { name: /The Counted Book/ }).waitFor({
      timeout: 20_000,
    })
    await first.app.close()

    // Two stretches an hour and a half apart on the same day: 45 min in all.
    const bookId = bookIdOf(dataDir, 'The Counted Book')
    const now = Date.now()
    seedSessions(dataDir, [
      { id: 's1', bookId, startedAt: now - 3 * 3600_000, endedAt: now - 3 * 3600_000 + 1800_000 },
      { id: 's2', bookId, startedAt: now - 3600_000, endedAt: now - 3600_000 + 900_000 },
    ])

    const { app: second, page } = await launchApp(dataDir)
    app = second
    await page.getByRole('button', { name: 'Reading statistics' }).click()

    const panel = page.locator('.stats-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.stats-headline-value')).toHaveText('45 min')
    await expect(panel.locator('.stats-tally-item').nth(0)).toContainText('1')
    // Two stretches, one book, and a streak that starts today.
    await expect(panel.locator('.stats-tally-item').nth(3)).toContainText('2')
    await expect(panel.locator('.stats-book-title')).toHaveText('The Counted Book')
    await expect(panel.locator('.stats-book-duration')).toHaveText('45 min')
    await expect(panel.locator('.stats-day')).toHaveCount(7)
    await expect(panel.locator('.stats-day.today')).toHaveCount(1)

    await panel.getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('.stats-panel')).toHaveCount(0)
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(booksDir, { recursive: true, force: true })
  }
})

test('reading statistics say so when nothing has been read', async () => {
  const { dataDir, booksDir } = makeTempDirs()
  let app: ElectronApplication | undefined
  try {
    const { app: launched, page } = await launchApp(dataDir)
    app = launched
    await page.getByRole('button', { name: 'Reading statistics' }).click()
    await expect(page.locator('.stats-empty')).toHaveText('Nothing recorded yet.')
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(booksDir, { recursive: true, force: true })
  }
})
