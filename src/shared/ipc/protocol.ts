/**
 * Typed message protocol between renderer and worker.
 *
 * The renderer sends WorkerRequest over a MessagePort and receives
 * WorkerResponse / WorkerEvent. Every request carries an id; responses echo
 * it. There are no generic string channels — adding an operation means
 * adding a typed variant here.
 */

import type { Book, LibraryQuery, LibraryQueryResult } from '../domain/types'

export type WorkerRequest =
  | { kind: 'library.query'; id: number; query: LibraryQuery }
  | { kind: 'library.continueReading'; id: number }
  | { kind: 'ping'; id: number }

export type WorkerResponse =
  | { kind: 'library.query.result'; id: number; result: LibraryQueryResult }
  | { kind: 'library.continueReading.result'; id: number; book: Book | null }
  | { kind: 'pong'; id: number }
  | { kind: 'error'; id: number; message: string }

/** Unsolicited incremental updates (per-book, never full-list resends). */
export type WorkerEvent = { kind: 'event'; event: { type: 'bookUpdated'; book: Book } }

export type WorkerMessage = WorkerResponse | WorkerEvent

/** IPC channel names used only for wiring the MessagePort, not for data. */
export const IPC = {
  /** Renderer asks main for a fresh MessagePort connected to the worker. */
  requestWorkerPort: 'liseur:request-worker-port',
  /** Main delivers the port to the renderer via postMessage. */
  workerPort: 'liseur:worker-port',
  /** Settings are tiny and owned by main (window bounds, theme). */
  settingsGet: 'liseur:settings-get',
  settingsSet: 'liseur:settings-set',
} as const
