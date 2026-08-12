import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, migrate } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'
import { BookRepository } from '../../src/worker/library/book-repository'
import { IngestionService } from '../../src/worker/library/ingestion'
import { LibraryService } from '../../src/worker/library/library-service'
import { buildEpub, FAKE_PNG } from './epub-fixture'
import type { Book } from '../../src/shared/domain/types'

let dataDir: string
let booksDir: string
let db: DatabaseSync
let added: Book[]

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'liseur-ingest-data-'))
  booksDir = mkdtempSync(join(tmpdir(), 'liseur-ingest-books-'))
  db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  added = []
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(booksDir, { recursive: true, force: true })
})

function service(): IngestionService {
  return new IngestionService(db, { dataDir, onBookAdded: (b) => added.push(b) })
}

function writeEpub(name: string, options?: Parameters<typeof buildEpub>[0]): string {
  const path = join(booksDir, name)
  writeFileSync(path, buildEpub(options))
  return path
}

describe('IngestionService.ingestFile', () => {
  it('ingests an EPUB: metadata, library row, cover cache, event', async () => {
    const path = writeEpub('sample.epub', { title: 'The Sample', creators: ['Jane Writer'] })
    const outcome = await service().ingestFile(path)

    expect(outcome.status).toBe('added')
    const book = (outcome as { status: 'added'; book: Book }).book
    expect(book.title).toBe('The Sample')
    expect(book.authors).toEqual(['Jane Writer'])
    expect(book.downloaded).toBe(true)
    expect(book.localPath).toBe(path)
    expect(book.coverId).toMatch(/^[a-f0-9]{24}\.png$/)

    // Cover bytes landed in the cache.
    const cached = join(dataDir, 'covers', book.coverId!)
    expect(existsSync(cached)).toBe(true)
    expect(readFileSync(cached)).toEqual(FAKE_PNG)

    // Queryable through the library service.
    const result = new LibraryService(db).query(
      { filter: 'all', sort: 'recent', direction: 'desc', search: '' },
      1,
    )
    expect(result.books.map((b) => b.id)).toEqual([book.id])

    // And reported incrementally.
    expect(added.map((b) => b.id)).toEqual([book.id])
  })

  it('falls back to the file name when the OPF has no title', async () => {
    const path = writeEpub('fallback-name.epub', { title: '' }) // no title element
    const outcome = await service().ingestFile(path)
    expect(outcome.status).toBe('added')
    expect((outcome as { status: 'added'; book: Book }).book.title).toBe('fallback-name')
  })

  it('skips the exact same file content (duplicate hash)', async () => {
    const a = writeEpub('a.epub')
    const b = join(booksDir, 'b.epub')
    writeFileSync(b, readFileSync(a)) // same bytes, different path

    const svc = service()
    expect((await svc.ingestFile(a)).status).toBe('added')
    const dup = await svc.ingestFile(b)
    expect(dup).toEqual({ status: 'skipped', reason: 'duplicate-hash' })
    expect(new BookRepository(db).count()).toBe(1)
  })

  it('skips different files sharing an OPF identifier', async () => {
    const a = writeEpub('first.epub', { title: 'First Edition' })
    const b = writeEpub('second.epub', { title: 'Second Edition' }) // same default identifier

    const svc = service()
    expect((await svc.ingestFile(a)).status).toBe('added')
    const dup = await svc.ingestFile(b)
    expect(dup).toEqual({ status: 'skipped', reason: 'duplicate-identifier' })
    expect(new BookRepository(db).count()).toBe(1)
  })

  it('skips invalid files without aborting', async () => {
    const path = join(booksDir, 'broken.epub')
    writeFileSync(path, 'definitely not a zip')
    const outcome = await service().ingestFile(path)
    expect(outcome).toEqual({ status: 'skipped', reason: 'invalid' })
  })

  it('works without a cover in the EPUB', async () => {
    const path = writeEpub('nocover.epub', { noCover: true })
    const outcome = await service().ingestFile(path)
    expect(outcome.status).toBe('added')
    expect((outcome as { status: 'added'; book: Book }).book.coverId).toBeUndefined()
  })
})

describe('IngestionService.scanFolder / addFolder', () => {
  it('scans recursively, registers the folder, and skips junk', async () => {
    writeEpub('one.epub', { identifier: 'id-1' })
    mkdirSync(join(booksDir, 'nested'))
    writeFileSync(join(booksDir, 'nested', 'two.epub'), buildEpub({ identifier: 'id-2' }))
    writeFileSync(join(booksDir, 'notes.txt'), 'not a book')

    const stats = await service().addFolder(booksDir)
    expect(stats).toEqual({ added: 2, skipped: 0, failed: 0 })
    expect(new BookRepository(db).count()).toBe(2)
    expect(new BookRepository(db).folders().map((f) => f.path)).toEqual([booksDir])
  })

  it('rescan is incremental: unchanged files skipped, new files added', async () => {
    const first = writeEpub('first.epub', { identifier: 'id-1' })
    const svc = service()
    await svc.addFolder(booksDir)

    // The fast path: same path + mtime + size, skipped without re-hashing.
    expect(await svc.ingestFile(first)).toEqual({ status: 'skipped', reason: 'unchanged' })

    writeEpub('second.epub', { identifier: 'id-2' })
    const stats = await svc.scanFolder(booksDir)
    expect(stats).toEqual({ added: 1, skipped: 1, failed: 0 })
    expect(new BookRepository(db).count()).toBe(2)

    // Startup-style rescan over registered folders is a no-op when nothing changed.
    await svc.rescanAll()
    expect(new BookRepository(db).count()).toBe(2)
  })

  it('addFolder is idempotent for the same path', async () => {
    const svc = service()
    await svc.addFolder(booksDir)
    await svc.addFolder(booksDir)
    expect(new BookRepository(db).folders()).toHaveLength(1)
  })

  it('reports an unreadable folder instead of throwing', async () => {
    const stats = await service().scanFolder(join(booksDir, 'does-not-exist'))
    expect(stats.failed).toBe(1)
  })
})
