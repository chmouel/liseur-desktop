import { describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'
import { BookRepository } from '../../src/worker/library/book-repository'
import { seedLibraryIfEmpty, SEED_LIBRARY_SIZE } from '../../src/worker/library/seed'
import { LibraryService } from '../../src/worker/library/library-service'
import type { LibraryQuery } from '../../src/shared/domain/types'

function freshDb() {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  return db
}

describe('seedLibraryIfEmpty', () => {
  it('seeds an empty database with the deterministic dataset', () => {
    const db = freshDb()
    expect(seedLibraryIfEmpty(db, 100)).toBe(true)
    expect(new BookRepository(db).count()).toBe(100)

    // Seeded books belong to no folder: folders are real on-disk locations
    // and a fake path would be rescanned (and warn) at every startup.
    expect(db.prepare('SELECT * FROM folders').all()).toHaveLength(0)
  })

  it('never reseeds a non-empty database', () => {
    const db = freshDb()
    seedLibraryIfEmpty(db, 50)
    expect(seedLibraryIfEmpty(db, 100)).toBe(false)
    expect(new BookRepository(db).count()).toBe(50)
  })

  it('keeps queries fast at the M2 acceptance size (10,000 books)', () => {
    const db = freshDb()
    seedLibraryIfEmpty(db, SEED_LIBRARY_SIZE)
    const service = new LibraryService(db)

    const queries: LibraryQuery[] = [
      { filter: 'all', sort: 'recent', direction: 'desc', search: '' },
      { filter: 'downloaded', sort: 'title', direction: 'asc', search: '' },
      { filter: 'unread', sort: 'author', direction: 'desc', search: '' },
      { filter: 'archived', sort: 'added', direction: 'desc', search: '' },
      { filter: 'all', sort: 'recent', direction: 'desc', search: 'glass' },
    ]
    for (const q of queries) {
      const start = performance.now()
      const result = service.query(q, 1)
      const elapsed = performance.now() - start
      expect(result.books.length).toBeGreaterThan(0)
      // Generous CI bound; dev machines measure single-digit ms.
      expect(elapsed).toBeLessThan(250)
    }
    expect(service.continueReading()).not.toBeNull()
  })
})
