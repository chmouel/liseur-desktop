import { describe, expect, it } from 'vitest'
import { LibraryService } from '../../src/worker/library/library-service'
import type { Book, LibraryQuery } from '../../src/shared/domain/types'

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

function query(overrides: Partial<LibraryQuery>) {
  return new LibraryService(BOOKS).query({ ...base, ...overrides }, 1)
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

  it('sorts by recent using lastOpenedAt', () => {
    const r = query({ sort: 'recent', direction: 'desc' })
    expect(r.books[0]?.id).toBe('e')
  })

  it('echoes requestId and totalCount', () => {
    const r = new LibraryService(BOOKS).query(base, 42)
    expect(r.requestId).toBe(42)
    expect(r.totalCount).toBe(4)
  })
})

describe('LibraryService.continueReading', () => {
  it('returns the most recently updated in-progress book', () => {
    expect(new LibraryService(BOOKS).continueReading()?.id).toBe('e')
  })

  it('returns null when nothing is in progress', () => {
    const none = BOOKS.filter((b) => !b.progress || b.finished)
    expect(new LibraryService(none).continueReading()).toBeNull()
  })
})
