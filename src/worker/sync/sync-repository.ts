import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Book, Locator } from '../../shared/domain/types'
import { rowToBook, BookRepository } from '../library/book-repository'
import type { RemoteBook, RemoteServer, ServerType } from './types'

/**
 * Sync persistence: remote server configs (never credentials), the coalesced
 * progress-push queue, and preserved sync conflicts.
 */

export interface QueueRow {
  bookId: string
  locator: Locator
  progression?: number | undefined
  updatedAt: number
}

export interface SyncConflictRow {
  bookId: string
  bookTitle: string
  serverId: string
  serverName: string
  remoteId: string
  localLocator: Locator
  localProgression?: number | undefined
  localUpdatedAt: number
  remoteLocator: Locator
  remoteProgression?: number | undefined
  remoteUpdatedAt: number
  detectedAt: number
}

export class SyncRepository {
  constructor(private readonly db: DatabaseSync) {}

  // --- servers -------------------------------------------------------------

  addServer(input: {
    type: ServerType
    name: string
    url: string
    username?: string
  }): RemoteServer {
    const id = createHash('sha256')
      .update(`${input.type}:${input.url}:${input.username ?? ''}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16)
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO remote_servers (id, type, name, url, username, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.type, input.name, input.url.replace(/\/+$/, ''), input.username ?? null, now)
    return {
      id,
      type: input.type,
      name: input.name,
      url: input.url,
      username: input.username,
      addedAt: now,
    }
  }

  getServer(id: string): RemoteServer | undefined {
    const row = this.db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(id) as
      Record<string, unknown> | undefined
    return row ? this.serverFromRow(row) : undefined
  }

  listServers(): RemoteServer[] {
    const rows = this.db
      .prepare('SELECT * FROM remote_servers ORDER BY added_at')
      .all() as unknown as Record<string, unknown>[]
    return rows.map((r) => this.serverFromRow(r))
  }

  removeServer(id: string): void {
    // Books keep their data; server_id unlinks via ON DELETE SET NULL.
    this.db.prepare('DELETE FROM remote_servers WHERE id = ?').run(id)
  }

  markSynced(id: string, at: number): void {
    this.db.prepare('UPDATE remote_servers SET last_sync_at = ? WHERE id = ?').run(at, id)
  }

  /** Per-server sync cursor (liseur-sync high_water). */
  setCursor(id: string, cursor: string): void {
    this.db.prepare('UPDATE remote_servers SET cursor = ? WHERE id = ?').run(cursor, id)
  }

  // --- server ↔ book links (many-to-many; liseur-sync work mappings) --------

  link(serverId: string, bookId: string, remoteId: string): void {
    this.db
      .prepare(
        `INSERT INTO server_book_links (server_id, book_id, remote_id) VALUES (?, ?, ?)
         ON CONFLICT(server_id, book_id) DO UPDATE SET remote_id = excluded.remote_id`,
      )
      .run(serverId, bookId, remoteId)
  }

  linkedRemoteId(serverId: string, bookId: string): string | undefined {
    const row = this.db
      .prepare('SELECT remote_id FROM server_book_links WHERE server_id = ? AND book_id = ?')
      .get(serverId, bookId) as { remote_id: string } | undefined
    return row?.remote_id
  }

  linkedBookId(serverId: string, remoteId: string): string | undefined {
    const row = this.db
      .prepare('SELECT book_id FROM server_book_links WHERE server_id = ? AND remote_id = ?')
      .get(serverId, remoteId) as { book_id: string } | undefined
    return row?.book_id
  }

  linkedBookIds(serverId: string): { bookId: string; remoteId: string }[] {
    const rows = this.db
      .prepare('SELECT book_id, remote_id FROM server_book_links WHERE server_id = ?')
      .all(serverId) as unknown as { book_id: string; remote_id: string }[]
    return rows.map((r) => ({ bookId: r.book_id, remoteId: r.remote_id }))
  }

  private serverFromRow(row: Record<string, unknown>): RemoteServer {
    return {
      id: row['id'] as string,
      type: row['type'] as ServerType,
      name: row['name'] as string,
      url: row['url'] as string,
      username: (row['username'] as string | null) ?? undefined,
      addedAt: row['added_at'] as number,
      lastSyncAt: (row['last_sync_at'] as number | null) ?? undefined,
      cursor: (row['cursor'] as string | null) ?? undefined,
    }
  }

  // --- remote books ----------------------------------------------------------

  findByRemoteId(serverId: string, remoteId: string): Book | undefined {
    const row = this.db
      .prepare(`SELECT b.id FROM books b WHERE b.server_id = ? AND b.remote_id = ? LIMIT 1`)
      .get(serverId, remoteId) as { id: string } | undefined
    if (!row) return undefined
    return new BookRepository(this.db).getById(row.id)
  }

  /**
   * Inserts a remote catalog shell (not downloaded) or refreshes metadata of
   * a known one. Returns the book and whether it was newly added.
   */
  upsertRemoteBook(serverId: string, remote: RemoteBook): { book: Book; added: boolean } {
    const existing = this.db
      .prepare('SELECT id FROM books WHERE server_id = ? AND remote_id = ?')
      .get(serverId, remote.remoteId) as { id: string } | undefined

    if (existing) {
      // Refresh metadata AND the catalog-provided URLs (OPDS hrefs are not
      // reconstructable later).
      this.db
        .prepare(
          'UPDATE books SET title = ?, authors = ?, download_url = ?, cover_url = ? WHERE id = ?',
        )
        .run(
          remote.title,
          JSON.stringify(remote.authors),
          remote.downloadUrl,
          remote.coverUrl ?? null,
          existing.id,
        )
      const book = new BookRepository(this.db).getById(existing.id)!
      return { book, added: false }
    }

    const id = `remote-${serverId}-${createHash('sha256').update(remote.remoteId).digest('hex').slice(0, 12)}`
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO books (id, folder_id, title, authors, local_path, remote_id, cover_id,
                            finished, archived, downloaded, added_at, server_id,
                            download_url, cover_url)
         VALUES (?, NULL, ?, ?, NULL, ?, NULL, 0, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        remote.title,
        JSON.stringify(remote.authors),
        remote.remoteId,
        now,
        serverId,
        remote.downloadUrl,
        remote.coverUrl ?? null,
      )
    const book = new BookRepository(this.db).getById(id)!
    return { book, added: true }
  }

  /** Catalog-provided URLs persisted at sync time. */
  remoteUrls(bookId: string): { downloadUrl: string | null; coverUrl: string | null } {
    const row = this.db
      .prepare('SELECT download_url, cover_url FROM books WHERE id = ?')
      .get(bookId) as { download_url: string | null; cover_url: string | null } | undefined
    return { downloadUrl: row?.download_url ?? null, coverUrl: row?.cover_url ?? null }
  }

  // --- progress queue (coalesced per book, persisted across restarts) --------

  enqueue(bookId: string, locator: Locator, progression: number | undefined, at: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_queue (book_id, locator, progression, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(book_id) DO UPDATE SET
           locator = excluded.locator,
           progression = excluded.progression,
           updated_at = excluded.updated_at`,
      )
      .run(bookId, JSON.stringify(locator), progression ?? null, at)
  }

  /**
   * Conditional dequeue: only removes the row if it still carries the exact
   * version we pushed — a newer enqueue during the network request survives.
   */
  dequeue(bookId: string, updatedAt?: number): void {
    if (updatedAt === undefined) {
      this.db.prepare('DELETE FROM sync_queue WHERE book_id = ?').run(bookId)
    } else {
      this.db
        .prepare('DELETE FROM sync_queue WHERE book_id = ? AND updated_at = ?')
        .run(bookId, updatedAt)
    }
  }

  /** Per-(book, server) durable acks: which queued version each target has. */
  recordAck(bookId: string, serverId: string, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_acks (book_id, server_id, acked_updated_at) VALUES (?, ?, ?)
         ON CONFLICT(book_id, server_id) DO UPDATE SET acked_updated_at = excluded.acked_updated_at`,
      )
      .run(bookId, serverId, updatedAt)
  }

  ackedAt(bookId: string, serverId: string): number {
    const row = this.db
      .prepare('SELECT acked_updated_at FROM sync_acks WHERE book_id = ? AND server_id = ?')
      .get(bookId, serverId) as { acked_updated_at: number } | undefined
    return row?.acked_updated_at ?? 0
  }

  clearAcks(bookId: string): void {
    this.db.prepare('DELETE FROM sync_acks WHERE book_id = ?').run(bookId)
  }

  /** Conflicts are target-specific (book × server). */
  hasConflict(bookId: string, serverId?: string): boolean {
    if (serverId === undefined) {
      return (
        this.db.prepare('SELECT 1 FROM sync_conflicts WHERE book_id = ?').get(bookId) !== undefined
      )
    }
    return (
      this.db
        .prepare('SELECT 1 FROM sync_conflicts WHERE book_id = ? AND server_id = ?')
        .get(bookId, serverId) !== undefined
    )
  }

  queue(): QueueRow[] {
    const rows = this.db
      .prepare('SELECT * FROM sync_queue ORDER BY updated_at')
      .all() as unknown as Record<string, unknown>[]
    return rows.map((r) => ({
      bookId: r['book_id'] as string,
      locator: JSON.parse(r['locator'] as string) as Locator,
      progression: (r['progression'] as number | null) ?? undefined,
      updatedAt: r['updated_at'] as number,
    }))
  }

  queueSize(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get() as { n: number }
    return row.n
  }

  // --- conflicts ---------------------------------------------------------------

  addConflict(conflict: Omit<SyncConflictRow, 'bookTitle' | 'serverName' | 'detectedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO sync_conflicts
           (book_id, server_id, remote_id, local_locator, local_progression, local_updated_at,
            remote_locator, remote_progression, remote_updated_at, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(book_id, server_id) DO UPDATE SET
           local_locator = excluded.local_locator,
           local_progression = excluded.local_progression,
           local_updated_at = excluded.local_updated_at,
           remote_locator = excluded.remote_locator,
           remote_progression = excluded.remote_progression,
           remote_updated_at = excluded.remote_updated_at,
           detected_at = excluded.detected_at`,
      )
      .run(
        conflict.bookId,
        conflict.serverId,
        conflict.remoteId,
        JSON.stringify(conflict.localLocator),
        conflict.localProgression ?? null,
        conflict.localUpdatedAt,
        JSON.stringify(conflict.remoteLocator),
        conflict.remoteProgression ?? null,
        conflict.remoteUpdatedAt,
        Date.now(),
      )
  }

  conflicts(): SyncConflictRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, b.title AS book_title, s.name AS server_name FROM sync_conflicts c
         JOIN books b ON b.id = c.book_id
         JOIN remote_servers s ON s.id = c.server_id
         ORDER BY c.detected_at DESC`,
      )
      .all() as unknown as Record<string, unknown>[]
    return rows.map((r) => ({
      bookId: r['book_id'] as string,
      bookTitle: r['book_title'] as string,
      serverId: r['server_id'] as string,
      serverName: r['server_name'] as string,
      remoteId: r['remote_id'] as string,
      localLocator: JSON.parse(r['local_locator'] as string) as Locator,
      localProgression: (r['local_progression'] as number | null) ?? undefined,
      localUpdatedAt: r['local_updated_at'] as number,
      remoteLocator: JSON.parse(r['remote_locator'] as string) as Locator,
      remoteProgression: (r['remote_progression'] as number | null) ?? undefined,
      remoteUpdatedAt: r['remote_updated_at'] as number,
      detectedAt: r['detected_at'] as number,
    }))
  }

  resolveConflict(bookId: string, serverId: string): void {
    this.db
      .prepare('DELETE FROM sync_conflicts WHERE book_id = ? AND server_id = ?')
      .run(bookId, serverId)
  }
}

/** Re-export for consumers that need row mapping. */
export { rowToBook }
