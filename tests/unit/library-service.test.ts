import { describe, expect, it, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, migrate } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'
import { BookRepository } from '../../src/worker/library/book-repository'
import { LibraryService } from '../../src/worker/library/library-service'
import type { Book, LibraryQuery } from '../../src/shared/domain/types'

/**
 * The Milestone 1 in-memory semantics, now verified against real SQL on an
 * in-memory database.
 */

function book(partial: Partial<Book> & { id: string }): Book {
  return {
    title: `Title ${partial.id}`,
    authors: ['Author'],
    downloaded: false,
    finished: false,
    archived: false,
    addedAt: 0,
    ...partial,
  }
}

const BOOKS: Book[] = [
  book({ id: 'a', title: 'The Glass Harbor', authors: ['Lea Frost'], addedAt: 100 }),
  book({
    id: 'b',
    title: 'River of Stars',
    authors: ['Otto Grey'],
    addedAt: 200,
    downloaded: true,
  }),
  book({
    id: 'c',
    title: 'Beneath the Tide',
    authors: ['Lea Frost'],
    addedAt: 300,
    finished: true,
    progress: { locator: { href: 'c.xhtml' }, progression: 1, updatedAt: 500 },
  }),
  book({ id: 'd', title: 'The Archive', authors: ['Sana Bell'], addedAt: 400, archived: true }),
  book({
    id: 'e',
    title: 'Signal at Dawn',
    authors: ['Amara Quinn'],
    addedAt: 500,
    lastOpenedAt: 900,
    progress: { locator: { href: 'e.xhtml' }, progression: 0.4, updatedAt: 900 },
  }),
]

const base: LibraryQuery = { filter: 'all', sort: 'added', direction: 'desc', search: '' }

let db: DatabaseSync

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  new BookRepository(db).insertBooks(BOOKS)
})

function query(overrides: Partial<LibraryQuery>) {
  return new LibraryService(db).query({ ...base, ...overrides }, 1)
}

describe('LibraryService.query', () => {
  it('filters: all excludes archived', () => {
    const r = query({})
    expect(r.books.map((b) => b.id)).toEqual(['e', 'c', 'b', 'a'])
  })

  it('filters: downloaded', () => {
    expect(query({ filter: 'downloaded' }).books.map((b) => b.id)).toEqual(['b'])
  })

  it('filters: unread excludes finished and archived', () => {
    expect(query({ filter: 'unread' }).books.map((b) => b.id)).toEqual(['e', 'b', 'a'])
  })

  it('filters: archived only', () => {
    expect(query({ filter: 'archived' }).books.map((b) => b.id)).toEqual(['d'])
  })

  it('searches title and author case-insensitively', () => {
    expect(query({ search: 'glass' }).books.map((b) => b.id)).toEqual(['a'])
    expect(query({ search: 'LEA' }).books.map((b) => b.id)).toEqual(['c', 'a'])
  })

  it('treats LIKE wildcards in search as literal characters', () => {
    expect(query({ search: '%' }).books).toEqual([])
    expect(query({ search: '_' }).books).toEqual([])
  })

  it('sorts by title ascending and descending', () => {
    expect(query({ sort: 'title', direction: 'asc' }).books.map((b) => b.id)).toEqual([
      'c',
      'b',
      'e',
      'a',
    ])
    expect(query({ sort: 'title', direction: 'desc' }).books.map((b) => b.id)).toEqual([
      'a',
      'e',
      'b',
      'c',
    ])
  })

  it('sorts by author using the first author', () => {
    expect(query({ sort: 'author', direction: 'asc' }).books.map((b) => b.id)).toEqual([
      'e', // Amara Quinn
      'a', // Lea Frost — tie with 'c' broken by id
      'c', // Lea Frost
      'b', // Otto Grey
    ])
  })

  it('sorts by recent using lastOpenedAt', () => {
    const r = query({ sort: 'recent', direction: 'desc' })
    expect(r.books[0]?.id).toBe('e')
  })

  it('echoes requestId and totalCount', () => {
    const r = new LibraryService(db).query(base, 42)
    expect(r.requestId).toBe(42)
    expect(r.totalCount).toBe(4)
  })

  it('round-trips optional fields', () => {
    new BookRepository(db).insertBooks([
      book({
        id: 'f',
        localPath: '/books/f.epub',
        remoteId: 'remote-1',
        coverId: 'cover-1',
        lastOpenedAt: 1234,
      }),
    ])
    const f = query({ search: 'Title f' }).books[0]
    expect(f).toMatchObject({
      localPath: '/books/f.epub',
      remoteId: 'remote-1',
      coverId: 'cover-1',
      lastOpenedAt: 1234,
    })
  })
})

describe('LibraryService.continueReading', () => {
  it('returns the most recently updated in-progress book', () => {
    expect(new LibraryService(db).continueReading()?.id).toBe('e')
  })

  it('returns null when nothing is in progress', () => {
    const none = BOOKS.filter((b) => !b.progress || b.finished)
    const empty = openDatabase(':memory:')
    migrate(empty, MIGRATIONS)
    new BookRepository(empty).insertBooks(none)
    expect(new LibraryService(empty).continueReading()).toBeNull()
  })
})
