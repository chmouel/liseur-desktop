import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, migrate } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'
import { IngestionService } from '../../src/worker/library/ingestion'
import { BookOpener } from '../../src/worker/library/open-book'
import { LibraryService } from '../../src/worker/library/library-service'
import { buildReaderEpub } from './epub-fixture'
import { EpubFile } from '../../src/worker/epub/epub'

let dataDir: string
let booksDir: string
let db: DatabaseSync
let bookId: string

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'liseur-reader-data-'))
  booksDir = mkdtempSync(join(tmpdir(), 'liseur-reader-books-'))
  db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)

  const path = join(booksDir, 'reader.epub')
  writeFileSync(path, buildReaderEpub({ chapters: 3 }))
  const outcome = await new IngestionService(db, { dataDir }).ingestFile(path)
  if (outcome.status !== 'added') throw new Error('fixture ingestion failed')
  bookId = outcome.book.id
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(booksDir, { recursive: true, force: true })
})

describe('EpubFile spine/toc', () => {
  it('reads the spine in order from a nav EPUB', () => {
    const epub = new EpubFile(buildReaderEpub({ chapters: 3 }))
    expect(epub.spine().map((s) => s.href)).toEqual([
      'OEBPS/text/ch1.xhtml',
      'OEBPS/text/ch2.xhtml',
      'OEBPS/text/ch3.xhtml',
    ])
    expect(epub.spine().every((s) => s.linear)).toBe(true)
  })

  it('parses the EPUB 3 nav document into a TOC', () => {
    const epub = new EpubFile(buildReaderEpub({ chapters: 3 }))
    const toc = epub.toc()
    expect(toc.map((t) => t.label)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3'])
    expect(toc[0]?.href).toBe('OEBPS/text/ch1.xhtml')
  })

  it('parses the EPUB 2 NCX into a TOC', () => {
    const epub = new EpubFile(buildReaderEpub({ chapters: 2, ncx: true }))
    const toc = epub.toc()
    expect(toc.map((t) => t.label)).toEqual(['Chapter 1', 'Chapter 2'])
    expect(toc[1]?.href).toBe('OEBPS/text/ch2.xhtml')
  })
})

describe('BookOpener', () => {
  it('opens a book: spine, toc, base URL, extraction cache', async () => {
    const opener = new BookOpener(db, dataDir)
    const opened = await opener.open(bookId)

    expect(opened.book.title).toBe('Reader Fixture')
    expect(opened.spine).toHaveLength(3)
    expect(opened.toc).toHaveLength(3)
    expect(opened.contentBaseUrl).toBe(`liseur-epub://book/${bookId}/`)

    // Extraction happened and is reusable.
    const marker = join(dataDir, 'extracted', bookId, '.liseur.json')
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(join(dataDir, 'extracted', bookId, 'OEBPS/text/ch1.xhtml'))).toBe(true)
    const before = readFileSync(marker, 'utf8')

    await opener.open(bookId) // second open: cache hit, marker unchanged
    expect(readFileSync(marker, 'utf8')).toBe(before)
  })

  it('marks the book as recently opened', async () => {
    const opener = new BookOpener(db, dataDir)
    const opened = await opener.open(bookId)
    expect(opened.book.lastOpenedAt).toBeGreaterThan(0)
  })

  it('rejects unknown books and books without files', async () => {
    const opener = new BookOpener(db, dataDir)
    await expect(opener.open('nope')).rejects.toThrow(/unknown book/)
  })
})

describe('progress persistence', () => {
  it('setProgress upserts and feeds continueReading', () => {
    const service = new LibraryService(db)
    const locator = { href: 'OEBPS/text/ch2.xhtml', locations: { progression: 0.5 } }

    const first = service.setProgress(bookId, locator, 0.42, 1000)
    expect(first.progress?.progression).toBe(0.42)
    expect(first.lastOpenedAt).toBe(1000)

    // Upsert: same book, new position — still a single progress row.
    const second = service.setProgress(bookId, locator, 0.9, 2000)
    expect(second.progress?.progression).toBe(0.9)
    expect(db.prepare('SELECT COUNT(*) AS n FROM reading_progress').get()).toEqual({ n: 1 })

    const continuing = service.continueReading()
    expect(continuing?.id).toBe(bookId)
    expect(continuing?.progress?.locator.href).toBe('OEBPS/text/ch2.xhtml')
  })

  it('progression 1 marks the book finished (and out of continue-reading)', () => {
    const service = new LibraryService(db)
    service.setProgress(bookId, { href: 'x' }, 1, 3000)
    const book = service.continueReading()
    expect(book).toBeNull()
    expect(
      (db.prepare('SELECT finished FROM books WHERE id = ?').get(bookId) as { finished: number })
        .finished,
    ).toBe(1)
  })
})
