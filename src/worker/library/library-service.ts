import type { Book, LibraryQuery, LibraryQueryResult } from '../../shared/domain/types'
import { generateFakeLibrary } from './fake-dataset'

/**
 * Library query engine — worker side.
 *
 * In Milestone 1 this serves the deterministic fake dataset; the interface is
 * exactly what the SQLite-backed implementation will satisfy in Milestone 2.
 * All filtering/sorting happens here so the renderer only receives the books
 * it asked for.
 */

function matchesSearch(book: Book, term: string): boolean {
  const q = term.toLowerCase()
  if (book.title.toLowerCase().includes(q)) return true
  return book.authors.some((a) => a.toLowerCase().includes(q))
}

function matchesFilter(book: Book, filter: LibraryQuery['filter']): boolean {
  switch (filter) {
    case 'all':
      return !book.archived
    case 'downloaded':
      return book.downloaded && !book.archived
    case 'unread':
      return !book.finished && !book.archived
    case 'archived':
      return book.archived
  }
}

function compare(a: Book, b: Book, query: LibraryQuery): number {
  const dir = query.direction === 'asc' ? 1 : -1
  switch (query.sort) {
    case 'recent':
      // Natural ascending by last-opened; 'desc' (default) = most recent first.
      return ((a.lastOpenedAt ?? 0) - (b.lastOpenedAt ?? 0)) * dir
    case 'title':
      return a.title.localeCompare(b.title) * dir
    case 'author':
      return (a.authors[0] ?? '').localeCompare(b.authors[0] ?? '') * dir
    case 'added':
      return (a.addedAt - b.addedAt) * dir
  }
}

export class LibraryService {
  private readonly books: Book[]

  constructor(books: Book[] = generateFakeLibrary()) {
    this.books = books
  }

  query(query: LibraryQuery, requestId: number): LibraryQueryResult {
    const term = query.search.trim()
    let result = this.books.filter((b) => matchesFilter(b, query.filter))
    if (term) result = result.filter((b) => matchesSearch(b, term))
    result.sort((a, b) => compare(a, b, query))
    return { books: result, totalCount: result.length, requestId }
  }

  /** The single most recently opened in-progress book. */
  continueReading(): Book | null {
    let best: Book | null = null
    for (const book of this.books) {
      if (!book.progress || book.finished || book.archived) continue
      if (book.progress.progression === undefined || book.progress.progression >= 1) continue
      if (!best) {
        best = book
        continue
      }
      const a = book.progress.updatedAt
      const b = best.progress!.updatedAt
      if (a > b) best = book
    }
    return best
  }
}
