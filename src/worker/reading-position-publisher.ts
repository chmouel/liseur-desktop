import type { Book, Locator } from '../shared/domain/types'

/**
 * Application-scoped position publisher — the worker equivalent of Android's
 * `ReadingPositionPublisher`. An Activity/ViewModel can disappear mid-write;
 * a reader component in the renderer can unmount the same way. This module
 * lives for the lifetime of the worker process (wired once in worker.ts,
 * outside any reader request handler), so a position accepted here survives
 * the renderer that sent it.
 *
 * Ordering: updates are processed strictly one at a time, in the order they
 * arrive — the same guarantee Android gets from a single-consumer channel.
 * The desktop worker already receives requests one message at a time (no
 * concurrent handlers), so a plain promise chain is enough to make that
 * ordering explicit and to serialize the commit pipeline against itself —
 * two publishes fired without awaiting one another still commit and
 * broadcast in the order they were queued.
 *
 * Sync only starts after commit: `enqueueSync` — which durably persists into
 * `sync_queue` and signals the foreground drain — is called only once the
 * SQLite write and the incremental `bookUpdated` broadcast have completed
 * for this exact update.
 *
 * Dependencies are plain functions rather than concrete service classes
 * (mirroring Android's constructor-injected lambdas): the publisher owns
 * only sequencing and error handling, and stays trivially testable with
 * fakes instead of a real database and sync stack.
 */
export interface PositionUpdate {
  bookId: string
  locator: Locator
  progression?: number | undefined
  updatedAt: number
}

export interface PositionPublisherDeps {
  /** Persists the position; returns the fresh book for broadcasting. */
  setProgress: (
    bookId: string,
    locator: Locator,
    progression: number | undefined,
    when: number,
  ) => Book
  /** Records the reading session sample for this position. */
  recordSession: (bookId: string, at: number, progression: number | undefined) => void
  /** Coalesces into the persisted sync queue and signals the foreground
   *  drain; durable and synchronous itself (the network push it triggers
   *  is not awaited here). */
  enqueueSync: (book: Book, locator: Locator, progression: number | undefined) => void
  /** Incremental per-book broadcast to every connected renderer. */
  onBookUpdated: (book: Book) => void
  log?: (message: string) => void
}

export class ReadingPositionPublisher {
  /** Serializes every publish against every other: one write at a time. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: PositionPublisherDeps) {}

  /**
   * Queues a position update and resolves once it has been durably
   * committed (SQLite write + sync_queue enqueue). Rejects on failure so the
   * caller (worker.ts) can surface it through the typed error path and keep
   * the renderer's outbox entry for replay — a failure here is never
   * silently dropped, and it never wedges a later update behind it.
   */
  publish(update: PositionUpdate): Promise<void> {
    const result = this.queue.then(() => this.commit(update))
    this.queue = result.catch(() => {})
    return result
  }

  private commit(update: PositionUpdate): void {
    const book = this.deps.setProgress(
      update.bookId,
      update.locator,
      update.progression,
      update.updatedAt,
    )
    this.deps.recordSession(update.bookId, update.updatedAt, update.progression)
    this.deps.onBookUpdated(book)
    try {
      this.deps.enqueueSync(book, update.locator, update.progression)
    } catch (err) {
      this.deps.log?.(`enqueue sync for ${update.bookId}: ${(err as Error).message}`)
      throw err
    }
  }
}
