import type { Locator } from '../../shared/domain/types'

/**
 * Remote catalog & sync capability model (M7).
 *
 * One server at a time: Komga → calibre-web → liseur-sync. Each server type
 * implements `RemoteCatalog`; optional capabilities are feature-detected via
 * the interface, matching the Android product model.
 *
 * Credentials never appear here: the auth HEADER is computed in main
 * (safeStorage) and handed to the worker in memory only.
 */

export type ServerType = 'komga' | 'calibre-web' | 'liseur-sync'

export interface RemoteServer {
  id: string
  type: ServerType
  name: string
  url: string
  username?: string | undefined
  addedAt: number
  lastSyncAt?: number | undefined
  /** Per-server catch-up cursor (liseur-sync high_water). */
  cursor?: string | undefined
}

export interface ProgressRecord {
  locator?: Locator | undefined
  progression?: number | undefined
  updatedAt?: number | undefined
  completed?: boolean | undefined
}

export interface RemoteBook {
  remoteId: string
  title: string
  authors: string[]
  sizeBytes?: number | undefined
  /** Direct URLs (the http layer attaches auth). */
  downloadUrl: string
  coverUrl?: string | undefined
  /** Server-reported read progress when available (Komga). */
  progress?: ProgressRecord | undefined
}

export interface TestResult {
  ok: boolean
  detail?: string
}

/**
 * Progress pull outcome. `missing` means the server genuinely has no
 * position for the book; `error` means we don't know — reconciliation must
 * NEVER run on an error (a timeout is not "server has no progress").
 */
export type PullResult =
  | { status: 'ok'; record: ProgressRecord }
  | { status: 'missing' }
  | { status: 'error'; detail: string }

/**
 * The capability interface. `listBooks` streams pages (async iterable) so a
 * catalog sync never materializes the whole remote library in memory.
 */
export interface RemoteCatalog {
  readonly server: RemoteServer
  testConnection(): Promise<TestResult>
  listBooks(query?: string): AsyncIterable<RemoteBook[]>
  download(book: RemoteBook): Promise<Buffer>
  fetchCover(book: RemoteBook): Promise<Buffer | null>

  /**
   * Does listBooks() report read progress on every book that has any? When
   * it does, a sync can skip the per-book progress request for the books the
   * listing left blank, which is most of a large shelf. Catalogs that leave
   * this unset are asked about every book, one at a time.
   */
  readonly listsProgress?: boolean

  /** Progress sync capability (all three current server types support it). */
  pullProgress(remoteId: string): Promise<PullResult>
  pushProgress(remoteId: string, progress: ProgressRecord): Promise<'ok' | 'stale' | 'rejected'>
  /** Best-effort mark-as-read when a book finishes. */
  markCompleted?(remoteId: string): Promise<void>
}
