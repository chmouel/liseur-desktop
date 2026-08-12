/**
 * Typed message protocol between renderer and worker.
 *
 * The renderer sends WorkerRequest over a MessagePort and receives
 * WorkerResponse / WorkerEvent. Every request carries an id; responses echo
 * it. There are no generic string channels — adding an operation means
 * adding a typed variant here.
 */

import type {
  Annotation,
  Book,
  HighlightColor,
  LibraryQuery,
  LibraryQueryResult,
  Locator,
  OpenedBook,
  SearchResult,
} from '../domain/types'

/** Sync types shared with the renderer (settings UI). */
export type ServerType = 'komga' | 'calibre-web' | 'liseur-sync'

export interface ServerInfo {
  id: string
  type: ServerType
  name: string
  url: string
  username?: string | undefined
  addedAt: number
  lastSyncAt?: number | undefined
  hasCredentials: boolean
}

export interface SyncConflictInfo {
  bookId: string
  bookTitle: string
  /** Conflicts are target-specific (book × server). */
  serverId: string
  serverName: string
  localProgression?: number | undefined
  localUpdatedAt: number
  remoteProgression?: number | undefined
  remoteUpdatedAt: number
  detectedAt: number
}

export interface SyncState {
  servers: ServerInfo[]
  queueSize: number
  syncing: boolean
  conflicts: SyncConflictInfo[]
}

export type WorkerRequest =
  | { kind: 'library.query'; id: number; query: LibraryQuery }
  | { kind: 'library.continueReading'; id: number }
  | { kind: 'reader.open'; id: number; bookId: string }
  | {
      kind: 'reader.setProgress'
      id: number
      bookId: string
      locator: Locator
      progression?: number | undefined
    }
  | { kind: 'reader.search'; id: number; bookId: string; query: string }
  | { kind: 'reader.searchCancel'; id: number }
  | { kind: 'annotations.list'; id: number; bookId: string }
  | {
      kind: 'annotations.create'
      id: number
      input: {
        bookId: string
        kind: 'highlight' | 'bookmark'
        locator: Locator
        color?: HighlightColor
        note?: string
      }
    }
  | {
      kind: 'annotations.update'
      id: number
      annotationId: string
      patch: { color?: HighlightColor | null; note?: string | null }
    }
  | { kind: 'annotations.delete'; id: number; annotationId: string }
  | {
      kind: 'sync.setupServer'
      id: number
      input: {
        type: ServerType
        name: string
        url: string
        username?: string
        /** The user's secret, sent once over the in-process port; persisted
         *  only via main's keychain-backed store, never in SQLite. */
        secret: string
      }
    }
  | { kind: 'sync.removeServer'; id: number; serverId: string }
  | { kind: 'sync.testConnection'; id: number; serverId: string }
  | { kind: 'sync.syncNow'; id: number; serverId: string }
  | { kind: 'sync.download'; id: number; bookId: string }
  /**
   * Fetch and cache one catalog book's cover. Answered by a bookUpdated
   * event rather than a response: the renderer fires these per card as the
   * grid scrolls and does not wait on any of them.
   */
  | { kind: 'sync.ensureCover'; id: number; bookId: string }
  | { kind: 'sync.getState'; id: number }
  | {
      kind: 'sync.resolveConflict'
      id: number
      bookId: string
      serverId: string
      choice: 'local' | 'server'
    }
  | { kind: 'ping'; id: number }

export type WorkerResponse =
  | { kind: 'library.query.result'; id: number; result: LibraryQueryResult }
  | { kind: 'library.continueReading.result'; id: number; book: Book | null }
  | { kind: 'reader.open.result'; id: number; result: OpenedBook }
  | { kind: 'reader.progress.saved'; id: number }
  | { kind: 'annotations.list.result'; id: number; annotations: Annotation[] }
  | { kind: 'annotations.create.result'; id: number; annotation: Annotation }
  | { kind: 'annotations.update.result'; id: number; annotation: Annotation | null }
  | { kind: 'annotations.delete.result'; id: number }
  | { kind: 'reader.search.done'; id: number }
  | {
      kind: 'sync.setupServer.result'
      id: number
      server: ServerInfo
      test: { ok: boolean; detail?: string }
    }
  | { kind: 'sync.removeServer.result'; id: number }
  | { kind: 'sync.testConnection.result'; id: number; ok: boolean; detail?: string }
  | { kind: 'sync.syncNow.result'; id: number; added: number; updated: number; error?: string }
  | { kind: 'sync.download.result'; id: number; book: Book | null }
  | { kind: 'sync.getState.result'; id: number; state: SyncState }
  | { kind: 'sync.resolveConflict.result'; id: number }
  | { kind: 'pong'; id: number }
  | { kind: 'error'; id: number; message: string }

/** Unsolicited incremental updates (per-book, never full-list resends). */
export type WorkerEvent = {
  kind: 'event'
  event:
    | { type: 'bookUpdated'; book: Book }
    | { type: 'bookAdded'; book: Book }
    | {
        /** Streaming in-book search results; id ties batches to the request. */
        type: 'reader.searchBatch'
        id: number
        results: SearchResult[]
        done: boolean
      }
    | { type: 'syncState'; state: SyncState }
}

export type WorkerMessage = WorkerResponse | WorkerEvent

/**
 * Control messages from main to the worker (posted on the utilityProcess
 * channel, not a MessagePort). Main never touches data; it only forwards
 * user intent — paths picked in native dialogs — for the worker to act on.
 */
export type MainToWorkerMessage =
  | { kind: 'ingest-files'; paths: string[] }
  | { kind: 'add-folder'; path: string }
  | { kind: 'rescan-folders' }
  | {
      /** Auth material for a server, decrypted from the OS-keychain store.
       *  In-memory only on both sides; never logged, never persisted here. */
      kind: 'server-credentials'
      serverId: string
      headers: Record<string, string>
      extra?: Record<string, string>
    }
  | {
      /** Acknowledges a store-secret request (ok or with error). */
      kind: 'secret-stored'
      requestId: string
      serverId: string
      error?: string
    }

/** Worker → main (utilityProcess channel). Secrets only ever flow toward
 *  main's keychain-backed store. store-secret is acknowledged so setup can
 *  report keychain failures instead of falsely succeeding. */
export type WorkerToMainMessage =
  | {
      kind: 'store-secret'
      requestId: string
      serverId: string
      headers: Record<string, string>
      extra?: Record<string, string>
    }
  | { kind: 'clear-secret'; serverId: string }

/** IPC channel names used only for wiring the MessagePort, not for data. */
export const IPC = {
  /** Renderer asks main for a fresh MessagePort connected to the worker. */
  requestWorkerPort: 'liseur:request-worker-port',
  /** Main delivers the port to the renderer via postMessage. */
  workerPort: 'liseur:worker-port',
  /** Settings are tiny and owned by main (window bounds, theme). */
  settingsGet: 'liseur:settings-get',
  settingsSet: 'liseur:settings-set',
  /** Renderer asks main for a native file/folder picker (M3 ingestion). */
  openEpubDialog: 'liseur:dialog:open-epub',
  addFolderDialog: 'liseur:dialog:add-folder',
  /** Reader lifecycle signals for the close-time progress flush handshake. */
  readerActive: 'liseur:reader-active',
  flushProgress: 'liseur:flush-progress',
  progressFlushed: 'liseur:progress-flushed',
  /** Credential presence checks (secrets themselves never cross IPC). */
  secretsHas: 'liseur:secrets-has',
  secretsClear: 'liseur:secrets-clear',
} as const

/** Renderer URL for a cached cover image (served by main's protocol). */
export function coverUrl(coverId: string): string {
  return `liseur-cover://cover/${encodeURIComponent(coverId)}`
}
