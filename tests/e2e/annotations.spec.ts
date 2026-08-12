import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildReaderEpub } from '../unit/epub-fixture'
import { installBook, launchApp, makeTempDirs, openBookByTitle, revealChrome } from './helpers'

/**
 * M6 end to end: highlights (create via selection, re-anchor after
 * typography change, note edit), bookmarks (toggle, list, jump), and
 * streaming in-book search with jump-to-result.
 */

let dataDir: string
let booksDir: string
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  ;({ dataDir, booksDir } = makeTempDirs())
  await installBook(dataDir, booksDir, 'ann.epub', buildReaderEpub({ chapters: 3 }))
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(booksDir, { recursive: true, force: true })
})

/** Selects the given text in the book iframe and lifts the mouse. */
async function selectTextInBook(page: Page, needle: string) {
  const frame = page.frameLocator('.reader-iframe')
  await frame.locator('body').evaluate((body, text) => {
    const doc = body.ownerDocument
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const at = (node.nodeValue ?? '').indexOf(text)
      if (at !== -1) {
        const range = doc.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + text.length)
        doc.getSelection()?.removeAllRanges()
        doc.getSelection()?.addRange(range)
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return
      }
      node = walker.nextNode()
    }
    throw new Error(`text not found: ${text}`)
  }, needle)
}

test('annotations and in-book search', async () => {
  test.setTimeout(60_000)
  ;({ app } = await launchApp(dataDir))
  const page = await app.firstWindow()
  await page.waitForSelector('.library-screen')
  await openBookByTitle(page, 'Reader Fixture')
  const iframe = page.frameLocator('.reader-iframe')
  await expect(iframe.locator('h1')).toHaveText('Chapter 1', { timeout: 10_000 })

  // --- highlight via selection ---------------------------------------------
  await selectTextInBook(page, 'word1 word1')
  const toolbar = page.getByRole('toolbar', { name: 'Highlight selection' })
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Highlight yellow' }).click()
  await expect(toolbar).not.toBeVisible()
  // The highlight renders through the IFRAME's own highlight registry.
  await expect
    .poll(() =>
      page
        .frameLocator('.reader-iframe')
        .locator('body')
        .evaluate((body) => {
          const registry = body.ownerDocument.defaultView?.CSS.highlights as unknown as
            Map<string, { size: number }> | undefined
          return registry?.get('liseur-hl-yellow')?.size
        }),
    )
    .toBe(1)

  // Highlight appears in the bookmarks & notes panel.
  await revealChrome(page)
  await page.getByRole('button', { name: 'Bookmarks and notes' }).click()
  const panel = page.getByRole('dialog', { name: 'Bookmarks and notes' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.annotation-jump')).toHaveCount(1)
  await expect(panel.locator('.annotation-jump').first()).toContainText('word1 word1')

  // --- highlight survives a typography change (re-anchored, still listed) ---
  await page.keyboard.press('Escape') // close panel
  await page.keyboard.press('+') // font size up → re-layout
  await page.keyboard.press('+')
  await revealChrome(page)
  await page.getByRole('button', { name: 'Bookmarks and notes' }).click()
  await expect(panel.locator('.annotation-jump')).toHaveCount(1)

  // --- add a note via the highlight click -----------------------------------
  await page.keyboard.press('Escape') // close panel
  await page.waitForTimeout(300)
  const hit = await iframe.locator('body').evaluate((body) => {
    // Find the highlighted text position and click it.
    const doc = body.ownerDocument
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      const at = (node.nodeValue ?? '').indexOf('word1 word1')
      if (at !== -1) {
        const range = doc.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 'word1 word1'.length)
        const rect = range.getBoundingClientRect()
        doc.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            clientX: rect.left + 5,
            clientY: rect.top + 5,
          }),
        )
        return true
      }
      node = walker.nextNode()
    }
    return false
  })
  expect(hit).toBe(true)
  const popover = page.getByRole('dialog', { name: 'Edit highlight' })
  await expect(popover).toBeVisible()
  await popover.getByRole('textbox', { name: 'Note' }).fill('remember this')
  await page.waitForTimeout(600) // debounced save (400 ms) lands
  await page.keyboard.press('Escape') // close popover
  await revealChrome(page)
  await page.getByRole('button', { name: 'Bookmarks and notes' }).click()
  await expect(panel.locator('.annotation-note-preview')).toContainText('remember this')
  await page.keyboard.press('Escape')

  // --- bookmark toggle + jump ------------------------------------------------
  // (panel already closed above)
  await revealChrome(page)
  await page.getByRole('button', { name: 'Bookmark this page' }).click()
  await page.getByRole('button', { name: 'Bookmarks and notes' }).click()
  await expect(panel.locator('.annotation-jump')).toHaveCount(2)

  // Jump to the bookmark from the panel (we're already there; still no-op safe).
  await panel
    .getByRole('button', { name: /Bookmark|Chapter/ })
    .first()
    .click()
  await expect(page.locator('.reader-screen')).toBeVisible()

  // --- in-book search ---------------------------------------------------------
  await revealChrome(page)
  await page.getByRole('button', { name: 'Search in book' }).click()
  const searchPanel = page.getByRole('dialog', { name: 'Search in book' })
  await expect(searchPanel).toBeVisible()
  await searchPanel.getByRole('searchbox').fill('word3')
  await expect(searchPanel.locator('.book-search-result').first()).toBeVisible({
    timeout: 10_000,
  })
  await expect(searchPanel.locator('.book-search-result').first()).toContainText('word3')

  // Jump to the result: lands in chapter 3.
  await searchPanel.locator('.book-search-result').first().click()
  await expect(iframe.locator('h1')).toHaveText('Chapter 3', { timeout: 10_000 })

  // --- annotations persist across reopen --------------------------------------
  await page.keyboard.press('Escape') // back to library
  await page.waitForSelector('.library-screen')
  await openBookByTitle(page, 'Reader Fixture')
  await expect(iframe.locator('h1')).toHaveText(/Chapter/, { timeout: 10_000 })
  await revealChrome(page)
  await page.getByRole('button', { name: 'Bookmarks and notes' }).click()
  await expect(panel.locator('.annotation-jump')).toHaveCount(2)
  await page.keyboard.press('Escape')

  // --- the annotations list is virtualized -------------------------------------
  // Back to the library, bulk-insert 40 annotations into the live DB (WAL
  // allows a brief second writer), reopen the book, and scroll to the last.
  await page.keyboard.press('Escape') // back to library
  await page.waitForSelector('.library-screen')
  // WAL allows one writer at a time; the app's worker may hold a write txn.
  // Retry the bulk insert briefly instead of flaking on "database is locked".
  const withDb = async (fn: (db: InstanceType<typeof DatabaseSync>) => void) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const db = new DatabaseSync(join(dataDir, 'liseur.db'))
        try {
          fn(db)
        } finally {
          db.close()
        }
        return
      } catch (err) {
        if (!(err as Error).message.includes('locked') || attempt > 20) throw err
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
  await withDb((db) => {
    const row = db.prepare("SELECT id FROM books WHERE title = 'Reader Fixture'").get() as {
      id: string
    }
    const now = Date.now()
    for (let i = 0; i < 40; i++) {
      db.prepare(
        `INSERT INTO annotations (id, book_id, kind, color, note, locator, created_at, updated_at)
         VALUES (?, ?, 'highlight', 'yellow', ?, ?, ?, ?)`,
      ).run(
        `bulk-${i}`,
        row.id,
        `bulk note ${i}`,
        JSON.stringify({
          href: 'OEBPS/text/ch1.xhtml',
          locations: { progression: 0.1 },
          text: { before: '', highlight: `word1 word1`, after: '' },
        }),
        now + i,
        now + i,
      )
    }
  })

  await openBookByTitle(page, 'Reader Fixture')
  await expect(iframe.locator('h1')).toHaveText(/Chapter/, { timeout: 10_000 })
  await revealChrome(page)
  await page.getByRole('button', { name: 'Bookmarks and notes' }).click()
  await expect(panel).toBeVisible()

  // Bounded DOM: never all 42 mounted at once.
  await expect(panel.locator('.annotation-jump').first()).toBeVisible()
  expect(await panel.locator('.annotations-item').count()).toBeLessThan(42)
  // Scroll to the bottom: the last annotation becomes reachable.
  await panel.locator('.annotations-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(panel.getByRole('button', { name: /bulk note 39/ })).toBeVisible()
})
