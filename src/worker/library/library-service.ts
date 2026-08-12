import type { DatabaseSync } from 'node:sqlite'
import type { Book, LibraryQuery, LibraryQueryResult, Locator } from '../../shared/domain/types'
import { BookRepository } from './book-repository'

/**
 * Library query engine — worker side.
 *
 * Milestone 2: backed by SQLite (see book-repository.ts for the SQL). All
 * filtering/sorting happens in the database so the renderer only receives
 * the books it asked for; the typed protocol is unchanged from M1.
 */
export class LibraryService {
  private readonly repository: BookRepository

  constructor(db: DatabaseSync) {
    this.repository = new BookRepository(db)
  }

  query(query: LibraryQuery, requestId: number): LibraryQueryResult {
    const books = this.repository.query(query)
    return { books, totalCount: books.length, requestId }
  }

  /** The single most recently updated in-progress book. */
  continueReading(): Book | null {
    return this.repository.continueReading()
  }

  /** Persists reading progress; returns the fresh book for broadcasting. */
  setProgress(
    bookId: string,
    locator: Locator,
    progression: number | undefined,
    when: number,
  ): Book {
    return this.repository.setProgress(bookId, locator, progression, when)
  }
}
