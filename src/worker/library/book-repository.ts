import type { DatabaseSync } from 'node:sqlite'
import type { Book, LibraryQuery, ReadingProgress } from '../../shared/domain/types'

/**
 * Book repository — all SQL touching the library tables lives here.
 *
 * Query semantics intentionally match the Milestone 1 in-memory service:
 * `archived` books only appear under the Archived filter, search matches
 * title and author, "recent" falls back to never-opened-last ordering.
 * Authors and locators round-trip through JSON columns.
 */

export interface Folder {
  id: string
  path: string
  addedAt: number
}

/** Extra provenance stored when a book is ingested from a real file (M3). */
export interface IngestExtras {
  folderId?: string
  fileHash: string
  epubIdentifier?: string
  fileMtime: number
  fileSize: number
}

interface BookRow {
  id: string
  title: string
  authors: string
  local_path: string | null
  remote_id: string | null
  server_id: string | null
  cover_id: string | null
  finished: number
  archived: number
  downloaded: number
  added_at: number
  last_opened_at: number | null
  locator: string | null
  progression: number | null
  progress_updated_at: number | null
}

const BOOK_SELECT = `
  SELECT b.id, b.title, b.authors, b.local_path, b.remote_id, b.server_id, b.cover_id,
         b.finished, b.archived, b.downloaded, b.added_at, b.last_opened_at,
         p.locator, p.progression, p.updated_at AS progress_updated_at
  FROM books b
  LEFT JOIN reading_progress p ON p.book_id = b.id
`

const FILTER_WHERE: Record<LibraryQuery['filter'], string> = {
  all: 'b.archived = 0',
  downloaded: 'b.downloaded = 1 AND b.archived = 0',
  unread: 'b.finished = 0 AND b.archived = 0',
  archived: 'b.archived = 1',
}

function orderBy(query: LibraryQuery): string {
  const dir = query.direction === 'asc' ? 'ASC' : 'DESC'
  // SQLite LIKE/COLLATE NOCASE are ASCII-only case-insensitive; close enough
  // to M1's toLowerCase matching and stable across platforms. The id
  // tiebreaker keeps ordering deterministic where the sort key ties.
  switch (query.sort) {
    case 'recent':
      return `ORDER BY COALESCE(b.last_opened_at, 0) ${dir}, b.id`
    case 'title':
      return `ORDER BY b.title COLLATE NOCASE ${dir}, b.id`
    case 'author':
      return `ORDER BY json_extract(b.authors, '$[0]') COLLATE NOCASE ${dir}, b.id`
    case 'added':
      return `ORDER BY b.added_at ${dir}, b.id`
  }
}

/** Escapes LIKE wildcards so user input matches literally. */
function likePattern(term: string): string {
  return `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

export function rowToBook(row: BookRow): Book {
  const book: Book = {
    id: row.id,
    title: row.title,
    authors: JSON.parse(row.authors) as string[],
    finished: row.finished === 1,
    archived: row.archived === 1,
    downloaded: row.downloaded === 1,
    addedAt: row.added_at,
  }
  if (row.local_path !== null) book.localPath = row.local_path
  if (row.remote_id !== null) book.remoteId = row.remote_id
  if (row.server_id !== null) book.serverId = row.server_id
  if (row.cover_id !== null) book.coverId = row.cover_id
  if (row.last_opened_at !== null) book.lastOpenedAt = row.last_opened_at
  if (row.locator !== null && row.progress_updated_at !== null) {
    const progress: ReadingProgress = {
      locator: JSON.parse(row.locator) as ReadingProgress['locator'],
      updatedAt: row.progress_updated_at,
    }
    if (row.progression !== null) progress.progression = row.progression
    book.progress = progress
  }
  return book
}

export class BookRepository {
  constructor(private readonly db: DatabaseSync) {}

  query(query: LibraryQuery): Book[] {
    let sql = `${BOOK_SELECT} WHERE ${FILTER_WHERE[query.filter]}`
    const params: string[] = []
    const term = query.search.trim()
    if (term) {
      sql += ` AND (b.title LIKE ? ESCAPE '\\' OR b.authors LIKE ? ESCAPE '\\')`
      const pattern = likePattern(term)
      params.push(pattern, pattern)
    }
    sql += ` ${orderBy(query)}`
    const rows = this.db.prepare(sql).all(...params) as unknown as BookRow[]
    return rows.map(rowToBook)
  }

  /** The single most recently updated in-progress book. */
  /**
   * The book to offer on the "Continue reading" banner.
   *
   * Reading activity is the later of "opened on this machine" and "position
   * changed", so a book opened seconds ago wins over the one you finished
   * with yesterday, and a book you got through on your phone still shows up
   * here once its progress syncs across. Sorting on the saved position
   * alone left the previous book on the banner, because a book opened for
   * the first time has no position to sort by yet.
   */
  continueReading(): Book | null {
    const row = this.db
      .prepare(
        `${BOOK_SELECT}
         WHERE b.finished = 0 AND b.archived = 0
           AND (b.last_opened_at IS NOT NULL OR p.progression IS NOT NULL)
           AND (p.progression IS NULL OR p.progression < 1)
         ORDER BY MAX(COALESCE(b.last_opened_at, 0), COALESCE(p.updated_at, 0)) DESC, b.id
         LIMIT 1`,
      )
      .get() as unknown as BookRow | undefined
    return row ? rowToBook(row) : null
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }
    return row.n
  }

  countArchived(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM books WHERE archived = 1').get() as {
      n: number
    }
    return row.n
  }

  /** Attaches a cached cover to a book that had none. */
  setCoverId(id: string, coverId: string): void {
    this.db.prepare('UPDATE books SET cover_id = ? WHERE id = ?').run(coverId, id)
  }

  countByFolder(folderId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM books WHERE folder_id = ?')
      .get(folderId) as { n: number }
    return row.n
  }

  findIdByHash(fileHash: string): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM books WHERE file_hash = ? LIMIT 1')
      .get(fileHash) as { id: string } | undefined
    return row?.id
  }

  getById(id: string): Book | undefined {
    const row = this.db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).get(id) as unknown as
      BookRow | undefined
    return row ? rowToBook(row) : undefined
  }

  /** Marks a remote shell as downloaded: sets the local file + cover. */
  setDownloadedFile(
    id: string,
    file: {
      localPath: string
      fileHash: string
      fileMtime: number
      fileSize: number
      coverId?: string | undefined
      epubIdentifier?: string | undefined
    },
  ): Book {
    this.db
      .prepare(
        `UPDATE books SET local_path = ?, file_hash = ?, file_mtime = ?, file_size = ?,
           downloaded = 1, cover_id = COALESCE(?, cover_id),
           epub_identifier = COALESCE(?, epub_identifier)
         WHERE id = ?`,
      )
      .run(
        file.localPath,
        file.fileHash,
        file.fileMtime,
        file.fileSize,
        file.coverId ?? null,
        file.epubIdentifier ?? null,
        id,
      )
    const book = this.getById(id)
    if (!book) throw new Error(`unknown book ${id}`)
    return book
  }

  /** Updates last_opened_at and returns the fresh book. */
  touchOpened(id: string, when: number): Book {
    this.db.prepare('UPDATE books SET last_opened_at = ? WHERE id = ?').run(when, id)
    const book = this.getById(id)
    if (!book) throw new Error(`unknown book ${id}`)
    return book
  }

  /**
   * Saves reading progress (upsert) and marks the book recently opened.
   * Finished state follows from progression ≥ 1. Returns the fresh book for
   * the bookUpdated broadcast.
   */
  setProgress(id: string, locator: unknown, progression: number | undefined, when: number): Book {
    this.db
      .prepare(
        `INSERT INTO reading_progress (book_id, locator, progression, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET
           locator = excluded.locator,
           progression = excluded.progression,
           updated_at = excluded.updated_at`,
      )
      .run(id, JSON.stringify(locator), progression ?? null, when)
    // Only a real progression flips finished state; a locator-only save
    // (progression unknown) must never unfinish a book.
    if (progression !== undefined && progression >= 1) {
      this.db
        .prepare('UPDATE books SET last_opened_at = ?, finished = 1 WHERE id = ?')
        .run(when, id)
    } else {
      this.db.prepare('UPDATE books SET last_opened_at = ? WHERE id = ?').run(when, id)
    }
    return this.touchOpened(id, when)
  }

  /** True when the file at `path` was already ingested with this mtime+size. */
  isUnchanged(path: string, fileMtime: number, fileSize: number): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM books WHERE local_path = ? AND file_mtime = ? AND file_size = ? LIMIT 1',
        )
        .get(path, fileMtime, fileSize) !== undefined
    )
  }

  findIdByIdentifier(epubIdentifier: string): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM books WHERE epub_identifier = ? LIMIT 1')
      .get(epubIdentifier) as { id: string } | undefined
    return row?.id
  }

  addFolder(folder: Folder): void {
    this.db
      .prepare('INSERT INTO folders (id, path, added_at) VALUES (?, ?, ?)')
      .run(folder.id, folder.path, folder.addedAt)
  }

  hasFolder(path: string): boolean {
    return this.db.prepare('SELECT 1 FROM folders WHERE path = ?').get(path) !== undefined
  }

  folders(): Folder[] {
    const rows = this.db
      .prepare('SELECT id, path, added_at FROM folders ORDER BY added_at')
      .all() as unknown as { id: string; path: string; added_at: number }[]
    return rows.map((r) => ({ id: r.id, path: r.path, addedAt: r.added_at }))
  }

  /** Bulk insert in a single transaction — used by seeding and M3 scanning. */
  insertBooks(books: readonly Book[], extras?: (book: Book) => IngestExtras | undefined): void {
    const insertBook = this.db.prepare(`
      INSERT INTO books (id, folder_id, title, authors, local_path, remote_id, cover_id,
                         finished, archived, downloaded, added_at, last_opened_at,
                         file_hash, epub_identifier, file_mtime, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertProgress = this.db.prepare(`
      INSERT INTO reading_progress (book_id, locator, progression, updated_at)
      VALUES (?, ?, ?, ?)
    `)
    this.db.exec('BEGIN')
    try {
      for (const book of books) {
        const extra = extras?.(book)
        insertBook.run(
          book.id,
          extra?.folderId ?? null,
          book.title,
          JSON.stringify(book.authors),
          book.localPath ?? null,
          book.remoteId ?? null,
          book.coverId ?? null,
          book.finished ? 1 : 0,
          book.archived ? 1 : 0,
          book.downloaded ? 1 : 0,
          book.addedAt,
          book.lastOpenedAt ?? null,
          extra?.fileHash ?? null,
          extra?.epubIdentifier ?? null,
          extra?.fileMtime ?? null,
          extra?.fileSize ?? null,
        )
        if (book.progress) {
          insertProgress.run(
            book.id,
            JSON.stringify(book.progress.locator),
            book.progress.progression ?? null,
            book.progress.updatedAt,
          )
        }
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}
