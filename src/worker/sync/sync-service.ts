import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Book, Locator } from '../../shared/domain/types'
import type { ServerInfo, SyncConflictInfo, SyncState } from '../../shared/ipc/protocol'
import { BookRepository } from '../library/book-repository'
import type { ReadingSessionRepository } from '../library/reading-sessions'
import { storeCoverBytes } from '../library/cover-cache'
import { reconcileProgress, withSaneTimestamp, type ReconcileAction } from './reconcile'
import { KomgaCatalog } from './komga'
import { CalibreCatalog, provisionKoboToken } from './calibre'
import { LiseurSyncCatalog, liseurSyncLogin } from './liseur-sync'
import { SyncRepository } from './sync-repository'
import type { FetchLike } from './http'
import type { ProgressRecord, RemoteBook, RemoteCatalog, RemoteServer, TestResult } from './types'

/**
 * Sync orchestration (M7). Catalog sync streams remote books into local
 * shell rows (bookAdded per page); downloads fetch EPUB bytes into the
 * library; progress flows through a persisted, coalesced queue (one row per
 * book, flushed on a debounce, on demand, and at startup — the queue
 * survives restarts). Conflicts are preserved for the catch-up UI, never
 * auto-resolved.
 *
 * All networking lives here (worker process only). Credentials arrive from
 * main as in-memory auth headers; nothing secret touches SQLite.
 */

/** Covers fetched at once. Enough to fill a screen quickly, few enough
 *  that the ones at the back are not waiting out their own timeout. */
const MAX_COVER_FETCHES = 4

/** Tries per cover before giving up, so a flaky moment is not permanent. */
const COVER_ATTEMPTS = 3

/**
 * How old a catalog has to be before returning to the window re-pulls it.
 * Long enough that alt-tabbing costs nothing, short enough that a book put
 * on the server over lunch is there when you come back. The env override
 * exists so the end-to-end test can watch a refresh happen.
 */
const STALE_CATALOG_MS = Number(process.env['LISEUR_SYNC_STALE_MS'] ?? 15 * 60_000)

export interface SyncDeps {
  onBookAdded: (book: Book) => void
  onBookUpdated: (book: Book) => void
  onStateChanged: (
    state: SyncState,
  ) => void /** Forwards a secret to main's keychain store; throws if it can't persist. */
  storeSecret: (
    serverId: string,
    headers: Record<string, string>,
    extra?: Record<string, string>,
  ) => Promise<void>
  clearSecret: (serverId: string) => void
  log?: (message: string) => void
  fetchImpl?: FetchLike
}

interface ServerCredentials {
  headers: Record<string, string>
  extra?: Record<string, string> | undefined
}

export class SyncService {
  private readonly repository: SyncRepository
  private readonly books: BookRepository
  private readonly credentials = new Map<string, ServerCredentials>()
  private readonly catalogs = new Map<string, RemoteCatalog>()
  private syncing = false
  /** Set once the worker hands over the reading-session recorder. */
  private sessions: ReadingSessionRepository | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** Servers whose catalog has already been pulled in this process. */
  private readonly caughtUp = new Set<string>()
  /** Cover fetches in flight, so scrolling cannot stampede one book. */
  private readonly coversInFlight = new Set<string>()
  /** Covers waiting their turn, oldest first (mirrored by a set for lookup). */
  private readonly coverQueue: string[] = []
  private readonly coverQueued = new Set<string>()
  /** Failed tries per book, so retries stop rather than spin. */
  private readonly coverAttempts = new Map<string, number>()
  /** Syncs running or queued, by server, so a second request joins the first. */
  private readonly inFlight = new Map<
    string,
    Promise<{ added: number; updated: number; error?: string }>
  >()
  /** Serializes the queued syncs: one server's catalog at a time. */
  private syncChain: Promise<void> = Promise.resolve()
  /** Why each server's last sync failed. Kept per server: one server going
   *  down must not erase the report, nor another's success hide it. */
  private readonly lastErrors = new Map<string, string>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly deps: SyncDeps,
  ) {
    this.repository = new SyncRepository(db)
    this.books = new BookRepository(db)
  }

  private log(message: string): void {
    this.deps.log?.(message)
  }

  // --- credentials (in memory only) -----------------------------------------

  setCredentials(serverId: string, credentials: ServerCredentials | null): void {
    if (!credentials || Object.keys(credentials.headers).length === 0) {
      this.credentials.delete(serverId)
      this.catalogs.delete(serverId)
      this.caughtUp.delete(serverId)
      return
    }
    this.credentials.set(serverId, credentials)
    this.catalogs.delete(serverId) // rebuild lazily
  }

  /**
   * Pulls a server's catalog once per process, when its credentials first
   * arrive. Without this the library only ever fills in if you find the
   * "Sync now" button, and books added on the server since last launch
   * never appear. Credentials are pushed again on every renderer connect,
   * hence the guard: this is a catch-up, not a poll.
   */
  catchUp(serverId: string): void {
    if (!this.credentials.has(serverId) || this.caughtUp.has(serverId)) return
    this.caughtUp.add(serverId)
    void this.syncNow(serverId)
  }

  private catalogFor(serverId: string): RemoteCatalog | null {
    const cached = this.catalogs.get(serverId)
    if (cached) return cached
    const server = this.repository.getServer(serverId)
    const credentials = this.credentials.get(serverId)
    if (!server || !credentials) return null
    const catalog =
      server.type === 'komga'
        ? new KomgaCatalog(server, credentials.headers, this.deps.fetchImpl)
        : server.type === 'calibre-web'
          ? new CalibreCatalog(
              server,
              credentials.headers,
              credentials.extra?.['koboToken'],
              this.deps.fetchImpl,
            )
          : new LiseurSyncCatalog(server, credentials.headers, this.deps.fetchImpl)
    this.catalogs.set(serverId, catalog)
    return catalog
  }

  // --- server management ------------------------------------------------------

  /**
   * Adds a server: exchanges the user's secret for auth material (Komga: API
   * key as-is; calibre-web: basic + provisioned Kobo token; liseur-sync:
   * login → scoped token), stores it via main's keychain, and tests the
   * connection. The plaintext secret never persists.
   */
  async setupServer(input: {
    type: 'komga' | 'calibre-web' | 'liseur-sync'
    name: string
    url: string
    username?: string
    secret: string
  }): Promise<{ server: ServerInfo; test: TestResult }> {
    const server = this.repository.addServer(input)
    let headers: Record<string, string> = {}
    let extra: Record<string, string> | undefined

    try {
      switch (input.type) {
        case 'komga':
          headers = { 'x-api-key': input.secret }
          break
        case 'calibre-web': {
          headers = {
            authorization: `Basic ${Buffer.from(`${input.username ?? ''}:${input.secret}`).toString('base64')}`,
          }
          const kobo = await provisionKoboToken(
            server.url,
            input.username ?? '',
            input.secret,
            this.deps.fetchImpl,
          )
          if (kobo) extra = { koboToken: kobo.token }
          break
        }
        case 'liseur-sync': {
          const login = await liseurSyncLogin(
            server.url,
            input.username ?? '',
            input.secret,
            this.deps.fetchImpl,
          )
          if (!login.ok) {
            this.repository.removeServer(server.id)
            return { server: this.serverInfo(server), test: { ok: false, detail: login.detail } }
          }
          headers = { authorization: `Bearer ${login.token}` }
          break
        }
      }
    } catch (err) {
      this.repository.removeServer(server.id)
      return {
        server: this.serverInfo(server),
        test: { ok: false, detail: (err as Error).message },
      }
    }

    // Persist via main's keychain store (acked — a failure surfaces to the
    // user instead of pretending the server is set up) and use in memory.
    try {
      await this.deps.storeSecret(server.id, headers, extra)
    } catch (err) {
      this.repository.removeServer(server.id)
      return {
        server: this.serverInfo(server),
        test: { ok: false, detail: `credential storage failed: ${(err as Error).message}` },
      }
    }
    this.setCredentials(server.id, { headers, extra })
    const test = (await this.catalogFor(server.id)?.testConnection()) ?? {
      ok: false,
      detail: 'no catalog',
    }
    this.emitState()
    // A server that connects but shows no books is indistinguishable from a
    // broken one. Pull the catalog straight away, in the background so the
    // settings dialog answers immediately.
    if (test.ok) void this.syncNow(server.id)
    return { server: this.serverInfo(server), test }
  }

  removeServer(serverId: string): void {
    this.repository.removeServer(serverId)
    this.credentials.delete(serverId)
    this.catalogs.delete(serverId)
    this.deps.clearSecret(serverId)
    this.emitState()
  }

  async testConnection(serverId: string): Promise<TestResult> {
    const catalog = this.catalogFor(serverId)
    if (!catalog) return { ok: false, detail: 'missing credentials' }
    return catalog.testConnection()
  }

  // --- catalog sync -------------------------------------------------------------

  /**
   * Full sync of one server: stream the catalog into local shell rows,
   * reconcile progress for books we track, then flush the push queue.
   *
   * Asking for a sync of a server that is already syncing joins the one in
   * flight rather than refusing. Adding a server starts a sync in the
   * background, and pressing "Sync now" a second later should wait for it,
   * not report an error at a user who did nothing wrong.
   *
   * A request for a DIFFERENT server waits its turn instead of being
   * refused. Every server's credentials arrive in the same tick at startup,
   * so refusing the second one meant its books only ever appeared after a
   * restart — and then only if it happened to go first.
   */
  syncNow(serverId: string): Promise<{ added: number; updated: number; error?: string }> {
    const running = this.inFlight.get(serverId)
    if (running) return running
    if (!this.catalogFor(serverId)) {
      return Promise.resolve({ added: 0, updated: 0, error: 'missing credentials' })
    }
    // One server at a time: a machine with three servers should not open
    // three catalogs' worth of connections at once.
    const done = this.syncChain.then(() => this.runSync(serverId))
    this.inFlight.set(serverId, done)
    this.syncChain = done.then(
      () => {},
      () => {}, // a failed sync must never wedge the ones behind it
    )
    void done.finally(() => {
      if (this.inFlight.get(serverId) === done) this.inFlight.delete(serverId)
    })
    return done
  }

  /**
   * Sync every server whose catalog has gone stale.
   *
   * A window left open for days would otherwise never see a book added on
   * the server, because the catalog is pulled once at startup. The renderer
   * calls this when the window regains focus, so there is no timer ticking
   * in an idle app. The age check lives here rather than in the renderer:
   * flicking between windows should cost nothing.
   */
  async refreshStale(maxAgeMs = STALE_CATALOG_MS): Promise<void> {
    const now = Date.now()
    for (const server of this.repository.listServers()) {
      if (!this.credentials.has(server.id)) continue
      if (server.lastSyncAt !== undefined && now - server.lastSyncAt < maxAgeMs) continue
      await this.syncNow(server.id)
    }
  }

  private async runSync(
    serverId: string,
  ): Promise<{ added: number; updated: number; error?: string }> {
    const catalog = this.catalogFor(serverId)
    if (!catalog) return { added: 0, updated: 0, error: 'missing credentials' }
    this.syncing = true
    this.emitState()

    let added = 0
    let updated = 0
    let error: string | undefined
    this.lastErrors.delete(serverId)
    // Remote ids the listing says have been read. Only these need the
    // per-book progress request; see reconcileServer.
    const withProgress = new Set<string>()
    try {
      for await (const page of catalog.listBooks()) {
        for (const remote of page) {
          if (remote.progress) withProgress.add(remote.remoteId)
          const { book, added: isNew } = this.repository.upsertRemoteBook(serverId, remote)
          if (isNew) {
            added++
            this.deps.onBookAdded(book)
          } else {
            updated++
          }
        }
        await new Promise((resolve) => setImmediate(resolve)) // interleave queries
      }
      // Catalog servers pull per-book; liseur-sync catches up via its
      // changes feed (cursor-persisted, 410 → heads resync).
      if (catalog instanceof LiseurSyncCatalog) await this.syncLiseurChanges(catalog)
      else await this.reconcileServer(catalog, withProgress)
      await this.uploadSessions(catalog)
      await this.flushQueue()
      this.repository.markSynced(serverId, Date.now())
    } catch (err) {
      error = (err as Error).message
      this.lastErrors.set(serverId, error)
      this.log(`sync ${serverId}: ${error}`)
      // A failed pull did not observe the catalog, so the server must not
      // be left claiming it synced.
      this.caughtUp.delete(serverId)
    } finally {
      this.syncing = false
      this.emitState()
    }
    return { added, updated, ...(error ? { error } : {}) }
  }

  /** All books tracked with a server: catalog rows plus liseur-sync links. */
  private trackedBooks(serverId: string): { bookId: string; remoteId: string }[] {
    const catalogRows = this.db
      .prepare(
        'SELECT id AS bookId, remote_id AS remoteId FROM books WHERE server_id = ? AND remote_id IS NOT NULL',
      )
      .all(serverId) as unknown as { bookId: string; remoteId: string }[]
    const linked = this.repository.linkedBookIds(serverId)
    const seen = new Set(catalogRows.map((r) => r.bookId))
    return [...catalogRows, ...linked.filter((l) => !seen.has(l.bookId))]
  }

  /** Pull remote progress for tracked books and reconcile against local. */
  /**
   * Reading stretches are recorded whether or not a server ever wants them;
   * a service that has been given the recorder can hand them over.
   */
  trackSessions(sessions: ReadingSessionRepository): void {
    this.sessions = sessions
  }

  /**
   * Hands finished reading stretches to a server that keeps statistics.
   *
   * Only stretches for books this server knows can be sent: the server
   * refuses a session for a work it has never heard of, and rightly so.
   */
  private async uploadSessions(catalog: RemoteCatalog): Promise<void> {
    if (!this.sessions || !catalog.pushSessions) return
    const links = new Map(
      this.trackedBooks(catalog.server.id).map((row) => [row.bookId, row.remoteId]),
    )
    if (links.size === 0) return
    const pending = this.sessions.pendingUpload([...links.keys()])
    if (pending.length === 0) return
    const payload = pending.flatMap((session) => {
      const workId = links.get(session.bookId)
      return workId ? [{ ...session, workId }] : []
    })
    try {
      if (await catalog.pushSessions(payload)) {
        this.sessions.markUploaded(pending.map((session) => session.id))
      }
    } catch (err) {
      // A refused batch is retried on the next sync; reading time is not
      // worth failing a sync over.
      this.log(`sessions: ${(err as Error).message}`)
    }
  }

  private async reconcileServer(catalog: RemoteCatalog, withProgress: Set<string>): Promise<void> {
    const rows = this.trackedBooks(catalog.server.id)
    const queued = new Map(this.repository.queue().map((q) => [q.bookId, q.updatedAt]))

    for (const row of rows) {
      const dirty = this.dirtyFor(row.bookId, catalog.server.id, queued)
      const target = { serverId: catalog.server.id, remoteId: row.remoteId }
      // A server that reports read progress in its listing has already told
      // us this book is untouched, so asking again would cost a round trip
      // to be told the same thing. An unread book only still needs
      // reconciling when we have a local position waiting to go up.
      if (catalog.listsProgress && !withProgress.has(row.remoteId)) {
        if (dirty) await this.reconcileRemoteRecord(row.bookId, null, true, target)
        continue
      }
      // Pull errors must never drive reconciliation (a timeout is not an
      // empty server): skip the book entirely.
      const pull = await catalog.pullProgress(row.remoteId)
      if (pull.status === 'error') {
        this.log(`pull ${row.remoteId}: ${pull.detail}`)
        continue
      }
      const remote = pull.status === 'ok' ? pull.record : null
      await this.reconcileRemoteRecord(row.bookId, remote, dirty, target)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /**
   * Is this queued position still dirty FOR THIS TARGET? A row stays queued
   * until every required target acks it, so global presence in the queue is
   * not per-target dirtiness — an acked target must not see "dirty" and
   * manufacture false conflicts.
   */
  private dirtyFor(bookId: string, serverId: string, queued: Map<string, number>): boolean {
    const queuedAt = queued.get(bookId)
    if (queuedAt === undefined) return false
    if (this.repository.hasConflict(bookId, serverId)) return false // suspended, not dirty
    return this.repository.ackedAt(bookId, serverId) < queuedAt
  }

  /**
   * Reconciles one book's local state against a remote position record from
   * one specific target. Shared by catalog-server pulls and liseur-sync
   * change ops — the same rules (epsilon, dirty queue, conflict
   * preservation) apply everywhere. Conflicts are recorded per target.
   */
  private async reconcileRemoteRecord(
    bookId: string,
    remoteRecord: ProgressRecord | null,
    localDirty: boolean,
    target?: { serverId: string; remoteId: string },
  ): Promise<void> {
    const remote = withSaneTimestamp(remoteRecord)
    // The server is holding a date that cannot be true. Ignoring it protects
    // us, but every other device still reads it, so send our position back up
    // to overwrite it even when the two positions already agree.
    const serverDateIsImpossible =
      remoteRecord?.updatedAt !== undefined && remote?.updatedAt === undefined
    const localBook = this.books.getById(bookId)
    if (!localBook) return
    const local: ProgressRecord | null = localBook.progress
      ? {
          locator: localBook.progress.locator,
          progression: localBook.progress.progression,
          updatedAt: localBook.progress.updatedAt,
          completed: localBook.finished,
        }
      : null
    const action: ReconcileAction = reconcileProgress(local, remote, localDirty)

    switch (action) {
      case 'pull': {
        if (remote?.locator || remote?.progression !== undefined || remote?.completed) {
          const at = remote.updatedAt ?? Date.now()
          const locator = remote.locator ?? localBook.progress?.locator ?? { href: '' }
          const book = this.books.setProgress(bookId, locator, remote.progression, at, false)
          this.deps.onBookUpdated(book)
          // The pulled position WON: it must propagate to the remaining
          // targets, never the superseded local value still sitting in the
          // queue. The queue version is a FRESH local-monotonic timestamp —
          // the remote timestamp could be older than another target's ack of
          // the superseded version, which would masquerade as delivery.
          const queueVersion = Math.max(at, Date.now())
          this.repository.enqueue(bookId, locator, remote.progression, queueVersion)
          if (target) this.repository.recordAck(bookId, target.serverId, queueVersion)
        }
        break
      }
      case 'adopt-status':
        if (remote?.completed && !localBook.finished) {
          const at = remote.updatedAt ?? Date.now()
          const locator = localBook.progress?.locator ?? { href: '' }
          const book = this.books.setProgress(bookId, locator, 1, at, false)
          this.deps.onBookUpdated(book)
          // Finished propagates like any other position (fresh queue version,
          // same anti-regression rule as pull).
          const queueVersion = Math.max(at, Date.now())
          this.repository.enqueue(bookId, locator, 1, queueVersion)
          if (target) this.repository.recordAck(bookId, target.serverId, queueVersion)
        }
        break
      case 'conflict':
        if (remote && target) {
          this.repository.addConflict({
            bookId,
            serverId: target.serverId,
            remoteId: target.remoteId,
            localLocator: local?.locator ?? { href: '' },
            localProgression: local?.progression,
            localUpdatedAt: local?.updatedAt ?? 0,
            remoteLocator: remote.locator ?? { href: '' },
            remoteProgression: remote.progression,
            remoteUpdatedAt: remote.updatedAt ?? 0,
          })
          // The queued local value stays but that TARGET is suspended from
          // flushing until the user resolves the conflict.
        }
        break
      case 'push':
        if (local?.locator) {
          this.repository.enqueue(
            bookId,
            local.locator,
            local.progression,
            local.updatedAt ?? Date.now(),
          )
        }
        break
      case 'none':
        if (serverDateIsImpossible && local?.locator) {
          this.repository.enqueue(
            bookId,
            local.locator,
            local.progression,
            local.updatedAt ?? Date.now(),
          )
        }
        break
    }
  }

  /**
   * liseur-sync catch-up: walk the changes feed from the persisted cursor,
   * page by page, reconciling each changed work like any other remote
   * position. The cursor advances ONLY after a page is fully processed; a
   * 410 resets it from /v1/heads; errors leave it untouched for next time.
   */
  private async syncLiseurChanges(catalog: LiseurSyncCatalog): Promise<void> {
    const server = this.repository.getServer(catalog.server.id)
    if (!server) return
    let cursor = server.cursor ?? ''
    const queued = new Map(this.repository.queue().map((q) => [q.bookId, q.updatedAt]))
    const MAX_PAGES = 200

    for (let page = 0; page < MAX_PAGES; page++) {
      const changes = await catalog.pullChanges(cursor)
      if (changes === 'resync') {
        // 410: the cursor fell off the server's retention window. The heads
        // snapshot carries current positions for all works + the resume
        // cursor; reconcile the snapshot like any other change.
        const head = await catalog.heads()
        if (head === null) return
        for (const op of head.ops) {
          const bookId = this.repository.linkedBookId(server.id, op.work_id)
          if (!bookId) continue
          await this.reconcileRemoteRecord(
            bookId,
            {
              progression: op.progression,
              locator: op.locator,
              updatedAt: Date.parse(op.client_ts) || undefined,
            },
            this.dirtyFor(bookId, server.id, queued),
            { serverId: server.id, remoteId: op.work_id },
          )
        }
        this.repository.setCursor(server.id, head.cursor)
        return
      }
      if (!changes) return // transient error: keep the cursor for next sync

      let maxSeq = 0
      for (const op of changes.ops) {
        const bookId = this.repository.linkedBookId(server.id, op.work_id)
        if (bookId) {
          // The op carries the position — no extra round trip needed.
          await this.reconcileRemoteRecord(
            bookId,
            {
              progression: op.progression,
              locator: op.locator,
              updatedAt: Date.parse(op.client_ts) || undefined,
            },
            this.dirtyFor(bookId, server.id, queued),
            { serverId: server.id, remoteId: op.work_id },
          )
        }
        const seq = typeof op.seq === 'number' ? op.seq : Number(op.seq)
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
        await new Promise((resolve) => setImmediate(resolve))
      }
      // Pagination: mid-feed the cursor is the max processed seq (the global
      // high_water would skip remaining pages); at the end it is high_water.
      cursor = changes.hasMore && maxSeq > 0 ? String(maxSeq) : changes.highWater
      this.repository.setCursor(server.id, cursor)
      if (!changes.hasMore) break
    }
  }

  // --- downloads ----------------------------------------------------------------

  /** Downloads a remote shell's EPUB into the library and marks it local. */
  async downloadBook(bookId: string): Promise<Book | null> {
    const book = this.books.getById(bookId)
    if (!book?.remoteId || !book.serverId) return null
    if (book.localPath) return book // already downloaded
    const catalog = this.catalogFor(book.serverId)
    if (!catalog) return null

    // Persisted catalog URLs (calibre-web OPDS hrefs), with per-type
    // fallbacks for rows synced before they were persisted.
    const stored = this.repository.remoteUrls(bookId)
    const remote: RemoteBook = {
      remoteId: book.remoteId,
      title: book.title,
      authors: book.authors,
      downloadUrl: stored.downloadUrl ?? downloadUrlFor(catalog, book.remoteId),
      coverUrl: stored.coverUrl ?? coverUrlFor(catalog, book.remoteId),
    }
    // Bounded read (512 MiB) — an untrusted server can't exhaust memory.
    const bytes = await catalog.download(remote)
    const fileHash = createHash('sha256').update(bytes).digest('hex')

    // Dedupe: a local copy of the same content means the SHELL points at
    // that file — never delete the shell (callers hold its id), never
    // duplicate the bytes on disk.
    const existingId = this.books.findIdByHash(fileHash)
    if (existingId && existingId !== bookId) {
      const existing = this.books.getById(existingId)!
      const updated = this.books.setDownloadedFile(bookId, {
        localPath: existing.localPath!,
        fileHash,
        fileMtime: Date.now(),
        fileSize: bytes.length,
        coverId: existing.coverId,
      })
      this.deps.onBookUpdated(updated)
      return updated
    }

    const dir = join(this.dataDir, 'downloads', book.serverId)
    mkdirSync(dir, { recursive: true })
    const filename = `${book.remoteId.replaceAll(/[^\w.-]/g, '_')}.epub`
    const target = join(dir, filename)
    writeFileSync(target, bytes)

    let coverId: string | undefined
    try {
      const coverBytes = await catalog.fetchCover(remote)
      if (coverBytes) coverId = storeCoverBytes(this.dataDir, coverBytes) ?? undefined
    } catch {
      // cover is best-effort; the book matters
    }
    const updated = this.books.setDownloadedFile(bookId, {
      localPath: target,
      fileHash,
      fileMtime: Date.now(),
      fileSize: bytes.length,
      coverId,
    })
    this.deps.onBookUpdated(updated)
    return updated
  }

  // --- covers -------------------------------------------------------------------

  /**
   * Fetches and caches one remote book's cover, on demand.
   *
   * Catalog sync deliberately does not do this: a Komga library of a few
   * thousand books would mean a few thousand image requests for art nobody
   * has scrolled to yet. The renderer asks per card as it comes into view,
   * and the cached cover arrives as a bookUpdated event.
   */
  ensureCover(bookId: string): void {
    if (this.coversInFlight.has(bookId) || this.coverQueued.has(bookId)) return
    const book = this.books.getById(bookId)
    if (!book?.remoteId || !book.serverId || book.coverId) return
    this.coverQueue.push(bookId)
    this.coverQueued.add(bookId)
    this.pumpCovers()
  }

  /**
   * Drains the cover queue a few at a time.
   *
   * Every request carries a timeout that starts when it is created, not
   * when the connection is free, so firing a screenful of covers at once
   * means the ones at the back time out while still queued — which looked
   * like a server that only had covers for the first twenty books.
   */
  private pumpCovers(): void {
    while (this.coversInFlight.size < MAX_COVER_FETCHES && this.coverQueue.length > 0) {
      const bookId = this.coverQueue.shift()!
      this.coverQueued.delete(bookId)
      this.coversInFlight.add(bookId)
      void this.fetchCover(bookId).finally(() => {
        this.coversInFlight.delete(bookId)
        this.pumpCovers()
      })
    }
  }

  private async fetchCover(bookId: string): Promise<void> {
    const book = this.books.getById(bookId)
    if (!book?.remoteId || !book.serverId || book.coverId) return
    const catalog = this.catalogFor(book.serverId)
    if (!catalog) return
    const coverUrl =
      this.repository.remoteUrls(bookId).coverUrl ?? coverUrlFor(catalog, book.remoteId)
    if (!coverUrl) return

    try {
      const bytes = await catalog.fetchCover({
        remoteId: book.remoteId,
        title: book.title,
        authors: book.authors,
        downloadUrl: '',
        coverUrl,
      })
      if (!bytes) return // the book has no art; nothing to retry
      const coverId = storeCoverBytes(this.dataDir, bytes)
      if (!coverId) return
      // Re-read: a download may have landed a cover while this was in the
      // air, and the downloaded one is the better of the two.
      const fresh = this.books.getById(bookId)
      if (!fresh || fresh.coverId) return
      this.books.setCoverId(bookId, coverId)
      const updated = this.books.getById(bookId)
      if (updated) this.deps.onBookUpdated(updated)
      this.coverAttempts.delete(bookId)
    } catch {
      // A timeout or a dropped connection is not "this book has no cover".
      // Give it a couple more goes, then leave it: a cover is decoration,
      // and an app sitting idle must not keep retrying forever.
      const attempts = (this.coverAttempts.get(bookId) ?? 0) + 1
      this.coverAttempts.set(bookId, attempts)
      if (attempts < COVER_ATTEMPTS) {
        this.coverQueue.push(bookId)
        this.coverQueued.add(bookId)
      }
    } finally {
      this.coversInFlight.delete(bookId)
    }
  }

  // --- progress queue -------------------------------------------------------------

  /** Called on every local progress save: coalesce into the persisted queue. */
  enqueueProgress(book: Book, locator: Locator, progression: number | undefined): void {
    const hasCatalogTarget = book.serverId && book.remoteId
    const hasSyncTarget = this.repository
      .listServers()
      .some((s) => s.type === 'liseur-sync' && this.credentials.has(s.id))
    if (!hasCatalogTarget && !hasSyncTarget) return
    this.repository.enqueue(book.id, locator, progression, Date.now())
    this.scheduleFlush()
    this.emitState()
  }

  private scheduleFlush(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flushQueue(), 2000)
  }

  /** Flushes are serialized: timer, manual and credential-triggered calls
   *  never overlap. */
  private flushChain: Promise<void> = Promise.resolve()

  async flushQueue(): Promise<void> {
    const run = this.flushChain.then(() => this.flushQueueLocked())
    this.flushChain = run.catch(() => {}) // a failed flush never wedges the chain
    await run
  }

  /** Pushes queued progress; stale pushes reconcile against the server. */
  private async flushQueueLocked(): Promise<void> {
    for (const row of this.repository.queue()) {
      const book = this.books.getById(row.bookId)
      if (!book) {
        this.repository.dequeue(row.bookId)
        continue
      }
      // Required targets: every configured server that must receive this
      // book's progress — the catalog origin (if that server still exists)
      // plus every liseur-sync server. Computed independently of what is
      // pushable right now, so an uncredentialed/unresolved target keeps the
      // row queued instead of being silently dropped.
      const servers = this.repository.listServers()
      const required: {
        serverId: string
        remoteId?: string | undefined
        catalog?: RemoteCatalog | undefined
      }[] = []
      if (book.serverId && book.remoteId && servers.some((s) => s.id === book.serverId)) {
        required.push({
          serverId: book.serverId,
          remoteId: book.remoteId,
          catalog: this.catalogFor(book.serverId) ?? undefined,
        })
      }
      for (const server of servers.filter(
        (s) => s.type === 'liseur-sync' && s.id !== book.serverId,
      )) {
        required.push({
          serverId: server.id,
          remoteId: this.repository.linkedRemoteId(server.id, book.id),
          catalog: this.catalogFor(server.id) ?? undefined,
        })
      }
      if (required.length === 0) {
        this.repository.dequeue(row.bookId)
        this.repository.clearAcks(row.bookId)
        continue
      }

      for (const target of required) {
        // Already delivered this exact version to this target.
        if (this.repository.ackedAt(row.bookId, target.serverId) >= row.updatedAt) continue
        // Per-target suspension: a conflict blocks only this target.
        if (this.repository.hasConflict(row.bookId, target.serverId)) continue
        const catalog = target.catalog
        if (!catalog) continue // credentials pending: un-acked, row survives
        let remoteId = target.remoteId
        if (!remoteId && catalog instanceof LiseurSyncCatalog) {
          const workId = await catalog.resolveWorkId({
            editionSha: this.fileHashOf(book),
            title: book.title,
            authors: book.authors,
          })
          if (workId) {
            this.repository.link(target.serverId, row.bookId, workId)
            remoteId = workId
          }
        }
        if (!remoteId) continue // unresolvable now: un-acked, row survives
        target.remoteId = remoteId
        try {
          const result = await catalog.pushProgress(remoteId, {
            locator: row.locator,
            progression: row.progression,
            updatedAt: row.updatedAt,
            completed: row.progression === 1,
          })
          if (result === 'ok') {
            this.repository.recordAck(row.bookId, target.serverId, row.updatedAt)
            if (row.progression === 1 && 'markCompleted' in catalog && catalog.markCompleted) {
              void catalog.markCompleted(remoteId)
            }
          } else if (result === 'stale') {
            await this.handleStalePush(catalog, book, row, {
              serverId: target.serverId,
              remoteId,
            })
          }
          // 'rejected': no ack — retried next flush
        } catch (err) {
          this.log(`push ${row.bookId} → ${target.serverId}: ${(err as Error).message}`)
        }
        await new Promise((resolve) => setImmediate(resolve))
      }

      // Delivered = every required target acked this version or is suspended
      // on a conflict the user must resolve. Unpushable targets block it.
      const delivered = required.every(
        (t) =>
          this.repository.hasConflict(row.bookId, t.serverId) ||
          this.repository.ackedAt(row.bookId, t.serverId) >= row.updatedAt,
      )
      if (delivered) {
        // Conditional: a newer enqueue during the requests survives.
        this.repository.dequeue(row.bookId, row.updatedAt)
        this.repository.clearAcks(row.bookId)
      }
    }
    this.emitState()
  }

  /** A stale push means the server moved ahead: pull, then reconcile. */
  /** A stale push means the server moved ahead: pull, then reconcile. All
   *  state changes are scoped to the target (book × server). */
  private async handleStalePush(
    catalog: RemoteCatalog,
    book: Book,
    row: { bookId: string; locator: Locator; progression?: number | undefined; updatedAt: number },
    target: { serverId: string; remoteId: string },
  ): Promise<void> {
    const pull = await catalog.pullProgress(target.remoteId)
    if (pull.status === 'error') return // no ack recorded; retried next flush
    const remote = withSaneTimestamp(pull.status === 'ok' ? pull.record : null)
    const action = reconcileProgress(
      { locator: row.locator, progression: row.progression, updatedAt: row.updatedAt },
      remote,
      true,
    )
    if (action === 'pull' && remote) {
      const updated = this.books.setProgress(
        row.bookId,
        remote.locator ?? row.locator,
        remote.progression,
        remote.updatedAt ?? Date.now(),
        false,
      )
      this.deps.onBookUpdated(updated)
      // Server state adopted: this target has the newer position.
      this.repository.recordAck(row.bookId, target.serverId, row.updatedAt)
    } else if (action === 'conflict' && remote) {
      this.repository.addConflict({
        bookId: row.bookId,
        serverId: target.serverId,
        remoteId: target.remoteId,
        localLocator: row.locator,
        localProgression: row.progression,
        localUpdatedAt: row.updatedAt,
        remoteLocator: remote.locator ?? { href: '' },
        remoteProgression: remote.progression,
        remoteUpdatedAt: remote.updatedAt ?? 0,
      })
    } else if (action === 'push') {
      // The 409 was clock skew, not a real regression: re-push with a fresh
      // timestamp once; a second stale verdict becomes a conflict.
      const retry = await catalog.pushProgress(target.remoteId, {
        locator: row.locator,
        progression: row.progression,
        updatedAt: Date.now(),
        completed: row.progression === 1,
      })
      if (retry === 'ok') {
        this.repository.recordAck(row.bookId, target.serverId, row.updatedAt)
      } else if (retry === 'stale' && remote) {
        this.repository.addConflict({
          bookId: row.bookId,
          serverId: target.serverId,
          remoteId: target.remoteId,
          localLocator: row.locator,
          localProgression: row.progression,
          localUpdatedAt: row.updatedAt,
          remoteLocator: remote.locator ?? { href: '' },
          remoteProgression: remote.progression,
          remoteUpdatedAt: remote.updatedAt ?? 0,
        })
      }
    }
  }

  private fileHashOf(book: Book): string | undefined {
    const row = this.db.prepare('SELECT file_hash FROM books WHERE id = ?').get(book.id) as
      { file_hash: string | null } | undefined
    return row?.file_hash ?? undefined
  }

  /** Flush whatever was queued when the app last ran (called at startup). */
  async flushQueueAtStartup(): Promise<void> {
    await this.flushQueue()
  }

  // --- conflicts -------------------------------------------------------------------

  conflicts(): SyncConflictInfo[] {
    return this.repository.conflicts().map((c) => ({
      bookId: c.bookId,
      bookTitle: c.bookTitle,
      serverId: c.serverId,
      serverName: c.serverName,
      localProgression: c.localProgression,
      localUpdatedAt: c.localUpdatedAt,
      remoteProgression: c.remoteProgression,
      remoteUpdatedAt: c.remoteUpdatedAt,
      detectedAt: c.detectedAt,
    }))
  }

  /**
   * Resolves a conflict by applying the chosen side durably. The conflict
   * row is cleared ONLY after the winning side is successfully applied —
   * "Use this device" pushes first and stays open if the push fails.
   */
  /**
   * Resolves a conflict for one specific target (book × server) by applying
   * the chosen side durably. The conflict row is cleared ONLY after the
   * winning side is successfully applied — "Use this device" pushes first
   * and stays open on failure. The queue row resumes flushing to the
   * resolved target via its ack.
   */
  async resolveConflict(
    bookId: string,
    serverId: string,
    choice: 'local' | 'server',
  ): Promise<void> {
    const conflict = this.repository
      .conflicts()
      .find((c) => c.bookId === bookId && c.serverId === serverId)
    if (!conflict) return
    const book = this.books.getById(bookId)
    if (!book) return
    const catalog = this.catalogFor(serverId)
    if (!catalog) return

    if (choice === 'local') {
      const result = await catalog.pushProgress(conflict.remoteId, {
        locator: conflict.localLocator,
        progression: conflict.localProgression,
        updatedAt: Date.now(),
      })
      if (result !== 'ok') return // keep the conflict; the queue row stays suspended
      // The queued local value is now delivered to this target.
      const queuedAt = this.repository.queue().find((q) => q.bookId === bookId)?.updatedAt
      this.repository.recordAck(bookId, serverId, queuedAt ?? Date.now())
    } else {
      const updated = this.books.setProgress(
        bookId,
        conflict.remoteLocator,
        conflict.remoteProgression,
        conflict.remoteUpdatedAt,
        false,
      )
      this.deps.onBookUpdated(updated)
      // The chosen REMOTE position replaces the stale local one in the
      // queue, so other targets receive the winner — never the loser. The
      // resolving target is acked for exactly this new version.
      const now = Date.now()
      this.repository.enqueue(bookId, conflict.remoteLocator, conflict.remoteProgression, now)
      this.repository.recordAck(bookId, serverId, now)
    }
    this.repository.resolveConflict(bookId, serverId)
    this.emitState()
  }

  // --- state -------------------------------------------------------------------------

  state(): SyncState {
    const [lastError] = this.lastErrors.values()
    return {
      servers: this.repository.listServers().map((s) => this.serverInfo(s)),
      queueSize: this.repository.queueSize(),
      syncing: this.syncing || this.inFlight.size > 0,
      conflicts: this.conflicts(),
      ...(lastError ? { lastError } : {}),
    }
  }

  private serverInfo(server: RemoteServer): ServerInfo {
    return { ...server, hasCredentials: this.credentials.has(server.id) }
  }

  private emitState(): void {
    this.deps.onStateChanged(this.state())
  }
}

/** URL conventions per server type (kept next to the clients). */
function downloadUrlFor(catalog: RemoteCatalog, remoteId: string): string {
  if (catalog instanceof KomgaCatalog) return `/api/v1/books/${remoteId}/file`
  // calibre-web: OPDS acquisition hrefs are per-book; the deterministic
  // fallback works across versions.
  return `/opds/download/${remoteId}/epub/`
}

function coverUrlFor(catalog: RemoteCatalog, remoteId: string): string | undefined {
  if (catalog instanceof KomgaCatalog) return `/api/v1/books/${remoteId}/thumbnail`
  return undefined
}

export { storeCoverBytes }
