import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'
import { AnnotationRepository } from '../../src/worker/library/annotation-repository'
import { IngestionService } from '../../src/worker/library/ingestion'
import { BookOpener } from '../../src/worker/library/open-book'
import { BookSearchService, extractText, findMatches } from '../../src/worker/library/book-search'
import { buildReaderEpub } from './epub-fixture'
import type { Locator } from '../../src/shared/domain/types'

let db: DatabaseSync
let bookId: string
let dataDir: string
let booksDir: string

const LOCATOR: Locator = {
  href: 'OEBPS/text/ch1.xhtml',
  locations: { progression: 0.5, cssSelector: 'p' },
  text: { before: 'Chapter 1', highlight: 'word1 word1', after: 'word1 word1' },
}

beforeEach(async () => {
  db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  dataDir = mkdtempSync(join(tmpdir(), 'liseur-ann-data-'))
  booksDir = mkdtempSync(join(tmpdir(), 'liseur-ann-books-'))
  writeFileSync(join(booksDir, 'book.epub'), buildReaderEpub({ chapters: 3 }))
  const outcome = await new IngestionService(db, { dataDir }).ingestFile(
    join(booksDir, 'book.epub'),
  )
  if (outcome.status !== 'added') throw new Error('fixture failed')
  bookId = outcome.book.id
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(booksDir, { recursive: true, force: true })
})

describe('AnnotationRepository', () => {
  it('creates, lists, updates and deletes highlights', () => {
    const repo = new AnnotationRepository(db)
    const created = repo.create({ bookId, kind: 'highlight', locator: LOCATOR, color: 'yellow' })
    expect(created.id).toBeTruthy()

    const listed = repo.list(bookId)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.locator.text?.highlight).toBe('word1 word1')
    expect(listed[0]?.locator.locations?.cssSelector).toBe('p')

    const updated = repo.update(created.id, { color: 'blue', note: 'important' })
    expect(updated?.color).toBe('blue')
    expect(updated?.note).toBe('important')
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

    repo.delete(created.id)
    expect(repo.list(bookId)).toHaveLength(0)
  })

  it('creates bookmarks', () => {
    const repo = new AnnotationRepository(db)
    repo.create({ bookId, kind: 'bookmark', locator: LOCATOR })
    expect(repo.list(bookId)[0]?.kind).toBe('bookmark')
  })

  it('cascades when the book is deleted', () => {
    const repo = new AnnotationRepository(db)
    repo.create({ bookId, kind: 'highlight', locator: LOCATOR })
    db.prepare('DELETE FROM books WHERE id = ?').run(bookId)
    expect(repo.list(bookId)).toHaveLength(0)
  })

  it('open returns annotations with the book', async () => {
    const repo = new AnnotationRepository(db)
    repo.create({ bookId, kind: 'highlight', locator: LOCATOR, color: 'pink' })
    const opened = await new BookOpener(db, dataDir).open(bookId)
    expect(opened.annotations).toHaveLength(1)
    expect(opened.annotations[0]?.color).toBe('pink')
  })
})

describe('book search', () => {
  it('extracts visible text, skipping scripts/styles', () => {
    const text = extractText(
      '<html><head><style>p { color: red }</style></head><body><p>Hello world</p><script>var x = "world"</script></body></html>',
    )
    expect(text).toBe('Hello world')
  })

  it('finds matches with context, case-insensitively', () => {
    const text = 'Alpha beta gamma. ALPHA Beta delta.'
    const matches = findMatches(text, 'alpha')
    expect(matches).toHaveLength(2)
    expect(matches[0]?.match).toBe('Alpha')
    expect(matches[0]?.after).toContain('beta')
  })

  it('streams results per chapter and completes', async () => {
    const service = new BookSearchService(db)
    const batches: number[] = []
    let done = false
    await service.search(bookId, 'word2', (results, isDone) => {
      if (isDone) {
        done = true
      } else {
        batches.push(results.length)
        for (const r of results) {
          expect(r.href).toBe('OEBPS/text/ch2.xhtml')
          expect(r.match.toLowerCase()).toBe('word2')
        }
      }
    })
    expect(done).toBe(true)
    expect(batches.length).toBeGreaterThan(0)
  })

  it('returns done with no batches for unknown books', async () => {
    const service = new BookSearchService(db)
    let done = false
    await service.search('nope', 'x', (_r, d) => {
      if (d) done = true
    })
    expect(done).toBe(true)
  })
})
