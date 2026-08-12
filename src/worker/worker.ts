import { type MessagePortMain } from 'electron'
import { join } from 'node:path'
import type { MainToWorkerMessage, WorkerMessage, WorkerRequest } from '../shared/ipc/protocol'
import { openDatabase, migrate } from './db/database'
import { MIGRATIONS } from './db/migrations'
import { LibraryService } from './library/library-service'
import { IngestionService } from './library/ingestion'
import { BookOpener } from './library/open-book'
import { AnnotationRepository } from './library/annotation-repository'
import { BookSearchService } from './library/book-search'
import { ReadingSessionRepository } from './library/reading-sessions'
import { SyncService } from './sync/sync-service'
import { seedLibraryIfEmpty } from './library/seed'

/**
 * Worker entry point. Runs in an Electron utilityProcess (isolated Node
 * context). Main hands us MessagePorts; each port serves one renderer.
 *
 * All work here is off the renderer's critical path. Heavy operations must
 * stay here or be dispatched asynchronously — never block a response.
 *
 * Note: Electron 43 exposes the parent channel as `process.parentPort`
 * (the `parentPort` export of the `electron` module was removed from
 * utilityProcess children).
 *
 * Environment contract (set by main in worker-host.ts):
 *   LISEUR_DATA_DIR          — where liseur.db lives (required)
 *   LISEUR_SEED_FAKE_LIBRARY — '1' seeds an empty DB with the deterministic
 *                              10,000-book fake dataset, for perf work.
 *                              Off unless asked for, including in dev.
 */

function initLibrary(): {
  library: LibraryService
  ingestion: IngestionService
  opener: BookOpener
  sessions: ReadingSessionRepository
  annotations: AnnotationRepository
  search: BookSearchService
  sync: SyncService
} {
  const dataDir = process.env.LISEUR_DATA_DIR
  if (!dataDir) throw new Error('LISEUR_DATA_DIR not set — worker must be launched by main')
  const db = openDatabase(join(dataDir, 'liseur.db'))
  migrate(db, MIGRATIONS)
  if (process.env.LISEUR_SEED_FAKE_LIBRARY === '1') {
    // One transaction in the worker; the window is already painting while
    // this runs, so startup is never blocked by it.
    if (seedLibraryIfEmpty(db)) console.info('[worker] seeded empty library for development')
  }
  const ingestion = new IngestionService(db, {
    dataDir,
    onBookAdded: (book) => broadcastEvent({ kind: 'event', event: { type: 'bookAdded', book } }),
    log: (message) => console.info(`[worker] ${message}`),
  })

  const sync = new SyncService(db, dataDir, {
    onBookAdded: (book) => broadcastEvent({ kind: 'event', event: { type: 'bookAdded', book } }),
    onBookUpdated: (book) =>
      broadcastEvent({ kind: 'event', event: { type: 'bookUpdated', book } }),
    onStateChanged: (state) =>
      broadcastEvent({ kind: 'event', event: { type: 'syncState', state } }),
    storeSecret: (serverId, headers, extra) => storeSecretInMain(serverId, headers, extra),
    clearSecret: (serverId) => parentPortRef?.postMessage({ kind: 'clear-secret', serverId }),
    log: (message) => console.info(`[worker] ${message}`),
  })

  const opener = new BookOpener(db, dataDir, (bookId) => sync.downloadBook(bookId))
  const sessions = new ReadingSessionRepository(db)
  sync.trackSessions(sessions)

  return {
    library: new LibraryService(db),
    ingestion,
    opener,
    sessions,
    annotations: new AnnotationRepository(db),
    search: new BookSearchService(db),
    sync,
  }
}

const { library, ingestion, opener, annotations, search, sync, sessions } = initLibrary()

/** process.parentPort kept in a variable for the sync secret forwarding. */
const parentPortRef = (
  process as NodeJS.Process & { parentPort?: { postMessage(m: unknown): void } }
).parentPort

/** store-secret requests awaiting main's acknowledgement. */
const pendingSecretStores = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()

function storeSecretInMain(
  serverId: string,
  headers: Record<string, string>,
  extra?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random()}`
    pendingSecretStores.set(requestId, { resolve, reject })
    parentPortRef?.postMessage({
      kind: 'store-secret',
      requestId,
      serverId,
      headers,
      ...(extra ? { extra } : {}),
    })
    setTimeout(() => {
      if (pendingSecretStores.delete(requestId)) {
        reject(new Error('secret store acknowledgement timed out'))
      }
    }, 5000)
  })
}

/** Active searches, scoped per port (request ids are per-renderer — a
 *  global set could collide across windows). Cancellation marks the entry;
 *  the scan's shouldContinue stops its work and releases its awaiter. */
interface ActiveSearch {
  id: number
  cancelled: boolean
}
const activeSearchByPort = new Map<MessagePortMain, ActiveSearch>()

function cancelSearchOn(port: MessagePortMain, id: number): void {
  const active = activeSearchByPort.get(port)
  if (!active || active.id !== id) return
  active.cancelled = true
  activeSearchByPort.delete(port)
  send(port, { kind: 'reader.search.done', id }) // release the awaiter now
}

const ports = new Set<MessagePortMain>()

function send(port: MessagePortMain, message: WorkerMessage): void {
  try {
    port.postMessage(message)
  } catch {
    // Renderer may have closed; drop the port.
    ports.delete(port)
  }
}

function handleRequest(port: MessagePortMain, request: WorkerRequest): void {
  switch (request.kind) {
    case 'library.query':
      send(port, {
        kind: 'library.query.result',
        id: request.id,
        result: library.query(request.query, request.id),
      })
      break
    case 'library.continueReading':
      send(port, {
        kind: 'library.continueReading.result',
        id: request.id,
        book: library.continueReading(),
      })
      break
    case 'reader.open':
      // Async: extraction runs off the message handler so other requests
      // (library queries) keep flowing while a book opens.
      void opener
        .open(request.bookId)
        .then((result) => {
          send(port, { kind: 'reader.open.result', id: request.id, result })
          // A sitting starts when the book opens, not at the first page turn:
          // reading the page you land on is reading.
          sessions.record(result.book.id, Date.now(), result.book.progress?.progression)
          // lastOpenedAt changed: keep library views incrementally fresh.
          broadcastEvent({ kind: 'event', event: { type: 'bookUpdated', book: result.book } })
        })
        .catch((err: Error) => send(port, { kind: 'error', id: request.id, message: err.message }))
      break
    case 'reader.setProgress': {
      const book = library.setProgress(
        request.bookId,
        request.locator,
        request.progression,
        Date.now(),
      )
      sessions.record(request.bookId, Date.now(), request.progression)
      send(port, { kind: 'reader.progress.saved', id: request.id })
      broadcastEvent({ kind: 'event', event: { type: 'bookUpdated', book } })
      // Remote books: coalesce into the persisted push queue.
      sync.enqueueProgress(book, request.locator, request.progression)
      break
    }
    case 'reader.search': {
      // Supersede any search still running on this port: stop its work and
      // release its awaiter before starting the new one.
      const stale = activeSearchByPort.get(port)
      if (stale && stale.id !== request.id) cancelSearchOn(port, stale.id)
      const entry: ActiveSearch = { id: request.id, cancelled: false }
      activeSearchByPort.set(port, entry)
      void search
        .search(
          request.bookId,
          request.query,
          (results, done) => {
            if (entry.cancelled || done) return
            send(port, {
              kind: 'event',
              event: { type: 'reader.searchBatch', id: request.id, results, done },
            })
          },
          () => !entry.cancelled,
        )
        .then(() => {
          if (!entry.cancelled) send(port, { kind: 'reader.search.done', id: request.id })
          if (activeSearchByPort.get(port) === entry) activeSearchByPort.delete(port)
        })
        .catch((err: Error) => send(port, { kind: 'error', id: request.id, message: err.message }))
      break
    }
    case 'reader.searchCancel':
      cancelSearchOn(port, request.id)
      break
    case 'sync.ensureCover':
      void sync.ensureCover(request.bookId)
      break
    case 'sync.setupServer':
      void sync
        .setupServer(request.input)
        .then((result) =>
          send(port, {
            kind: 'sync.setupServer.result',
            id: request.id,
            server: result.server,
            test: result.test,
          }),
        )
        .catch((err: Error) => send(port, { kind: 'error', id: request.id, message: err.message }))
      break
    case 'sync.removeServer':
      sync.removeServer(request.serverId)
      send(port, { kind: 'sync.removeServer.result', id: request.id })
      break
    case 'sync.testConnection':
      void sync
        .testConnection(request.serverId)
        .then((result) =>
          send(port, {
            kind: 'sync.testConnection.result',
            id: request.id,
            ok: result.ok,
            ...(result.detail ? { detail: result.detail } : {}),
          }),
        )
        .catch((err: Error) => send(port, { kind: 'error', id: request.id, message: err.message }))
      break
    case 'sync.syncNow':
      void sync
        .syncNow(request.serverId)
        .then((result) =>
          send(port, {
            kind: 'sync.syncNow.result',
            id: request.id,
            added: result.added,
            updated: result.updated,
            ...(result.error ? { error: result.error } : {}),
          }),
        )
        .catch((err: Error) => send(port, { kind: 'error', id: request.id, message: err.message }))
      break
    case 'sync.refreshStale':
      void sync
        .refreshStale()
        .then(() => send(port, { kind: 'sync.refreshStale.result', id: request.id }))
        .catch((err: Error) => send(port, { kind: 'error', id: request.id, message: err.message }))
      break
    case 'sync.download':
      void sync
        .downloadBook(request.bookId)
        .then((book) => send(port, { kind: 'sync.download.result', id: request.id, book }))
        .catch((err: Error) => send(port, { kind: 'error', id: request.id, message: err.message }))
      break
    case 'sync.getState':
      send(port, { kind: 'sync.getState.result', id: request.id, state: sync.state() })
      break
    case 'sync.resolveConflict':
      void sync
        .resolveConflict(request.bookId, request.serverId, request.choice)
        .then(() => send(port, { kind: 'sync.resolveConflict.result', id: request.id }))
        .catch((err: Error) => send(port, { kind: 'error', id: request.id, message: err.message }))
      break
    case 'annotations.list':
      send(port, {
        kind: 'annotations.list.result',
        id: request.id,
        annotations: annotations.list(request.bookId),
      })
      break
    case 'annotations.create':
      send(port, {
        kind: 'annotations.create.result',
        id: request.id,
        annotation: annotations.create(request.input),
      })
      break
    case 'annotations.update':
      send(port, {
        kind: 'annotations.update.result',
        id: request.id,
        annotation: annotations.update(request.annotationId, request.patch) ?? null,
      })
      break
    case 'annotations.delete':
      annotations.delete(request.annotationId)
      send(port, { kind: 'annotations.delete.result', id: request.id })
      break
    case 'ping':
      send(port, { kind: 'pong', id: request.id })
      break
    default: {
      // Exhaustiveness guard — a new request variant must be handled here.
      const _never: never = request
      return _never
    }
  }
}

const parentPort = (process as NodeJS.Process & { parentPort?: NodeJS.EventEmitter }).parentPort

/** Control messages from main (dialogs, rescans). Fire-and-forget. */
function handleControlMessage(message: MainToWorkerMessage): void {
  switch (message.kind) {
    case 'ingest-files':
      void Promise.all(message.paths.map((p) => ingestion.ingestFile(p)))
      break
    case 'add-folder':
      void ingestion.addFolder(message.path)
      break
    case 'rescan-folders':
      void ingestion.rescanAll()
      break
    case 'server-credentials':
      sync.setCredentials(
        message.serverId,
        Object.keys(message.headers).length > 0
          ? { headers: message.headers, extra: message.extra }
          : null,
      )
      // Credentials arriving (spawn or connect) flush whatever progress was
      // queued while the app was last running — the queue persists restarts —
      // and pull the catalog once, so books added on the server while the
      // app was closed are on the shelf without anyone pressing a button.
      if (Object.keys(message.headers).length > 0) {
        void sync.flushQueue()
        sync.catchUp(message.serverId)
      }
      break
    case 'secret-stored': {
      const pending = pendingSecretStores.get(message.requestId)
      if (pending) {
        pendingSecretStores.delete(message.requestId)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve()
      }
      break
    }
    default: {
      const _never: never = message
      return _never
    }
  }
}

parentPort?.on(
  'message',
  (event: { data?: MainToWorkerMessage; ports: readonly MessagePortMain[] }) => {
    const [port] = event.ports
    if (!port) {
      // No port attached: a typed control message from main.
      if (event.data && typeof event.data === 'object' && 'kind' in event.data) {
        handleControlMessage(event.data)
      }
      return
    }
    ports.add(port)
    port.on('message', (messageEvent: { data: WorkerRequest }) => {
      handleRequest(port, messageEvent.data)
    })
    port.on('close', () => {
      ports.delete(port)
      // A closed renderer can't consume results: stop its scan silently.
      const active = activeSearchByPort.get(port)
      if (active) active.cancelled = true
      activeSearchByPort.delete(port)
    })
    port.start()

    // Pick up files added to registered folders while the app was closed.
    // Triggered on renderer connect (not at boot) so bookAdded events can
    // never be emitted before a listener exists. Idempotent: unchanged
    // files are stat-skipped, so a reconnect costs a folder walk only.
    void ingestion.rescanAll()
  },
)

export function broadcastEvent(message: WorkerMessage): void {
  for (const port of ports) send(port, message)
}
