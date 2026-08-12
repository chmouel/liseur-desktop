/**
 * Preload bridge — the only Node-adjacent code the renderer can see.
 *
 * Exposes a narrow, typed `window.liseur` API. There is no generic
 * invoke(channel, args) escape hatch: every operation is an explicit method
 * with typed parameters. Adding an operation = adding a typed method here.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc/protocol'
import type {
  ServerInfo,
  ServerType,
  SyncState,
  WorkerMessage,
  WorkerRequest,
} from '../shared/ipc/protocol'
import type {
  Annotation,
  Book,
  HighlightColor,
  LibraryQuery,
  LibraryQueryResult,
  Locator,
  OpenedBook,
  SearchResult,
  Settings,
} from '../shared/domain/types'

/** Lazily-created MessagePort straight to the worker. */
let workerPortPromise: Promise<MessagePort> | undefined

function getWorkerPort(): Promise<MessagePort> {
  if (!workerPortPromise) {
    workerPortPromise = new Promise((resolve) => {
      ipcRenderer.once(IPC.workerPort, (event: IpcRendererEvent) => {
        const [port] = event.ports
        if (!port) throw new Error('worker port missing from IPC message')
        // Attach the handler before start() so no message can be dropped.
        port.onmessage = (messageEvent) => {
          const message = messageEvent.data as WorkerMessage
          if (message.kind === 'event') {
            for (const listener of eventListeners) listener(message)
            return
          }
          const resolve = pending.get(message.id)
          if (resolve) {
            pending.delete(message.id)
            resolve(message)
          }
        }
        port.start()
        resolve(port)
      })
      ipcRenderer.send(IPC.requestWorkerPort)
    })
  }
  return workerPortPromise
}

let nextId = 1
const pending = new Map<number, (message: WorkerMessage) => void>()
const eventListeners = new Set<(message: WorkerMessage) => void>()

async function request<T extends WorkerMessage>(
  build: (id: number) => WorkerRequest,
  isMatch: (message: WorkerMessage, id: number) => message is T,
): Promise<T> {
  const port = await getWorkerPort()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, (message) => {
      if (message.kind === 'error') reject(new Error(message.message))
      else resolve(message as T)
    })
    port.postMessage(build(id))
  }).then((message) => {
    if (!isMatch(message, id)) throw new Error(`unexpected worker response: ${message.kind}`)
    return message
  })
}

/** Fire-and-forget: the worker answers with an event, or not at all. */
async function notify(build: (id: number) => WorkerRequest): Promise<void> {
  const port = await getWorkerPort()
  port.postMessage(build(nextId++))
}

const api = {
  library: {
    query(query: LibraryQuery): Promise<LibraryQueryResult> {
      return request(
        (id) => ({ kind: 'library.query', id, query }),
        (m): m is Extract<WorkerMessage, { kind: 'library.query.result' }> =>
          m.kind === 'library.query.result',
      ).then((r) => r.result)
    },
    continueReading(): Promise<Book | null> {
      return request(
        (id) => ({ kind: 'library.continueReading', id }),
        (m): m is Extract<WorkerMessage, { kind: 'library.continueReading.result' }> =>
          m.kind === 'library.continueReading.result',
      ).then((r) => r.book)
    },
    /** Incremental per-book updates from the worker. */
    onBookUpdated(listener: (book: Book) => void): () => void {
      const handler = (message: WorkerMessage) => {
        if (message.kind === 'event' && message.event.type === 'bookUpdated') {
          listener(message.event.book)
        }
      }
      eventListeners.add(handler)
      return () => eventListeners.delete(handler)
    },
    /** Newly ingested books (M3), emitted one at a time during scans. */
    onBookAdded(listener: (book: Book) => void): () => void {
      const handler = (message: WorkerMessage) => {
        if (message.kind === 'event' && message.event.type === 'bookAdded') {
          listener(message.event.book)
        }
      }
      eventListeners.add(handler)
      return () => eventListeners.delete(handler)
    },
  },
  reader: {
    open(bookId: string): Promise<OpenedBook> {
      return request(
        (id) => ({ kind: 'reader.open', id, bookId }),
        (m): m is Extract<WorkerMessage, { kind: 'reader.open.result' }> =>
          m.kind === 'reader.open.result',
      ).then((r) => r.result)
    },
    /** Persist reading progress; debounced by the caller — fire and forget. */
    setProgress(bookId: string, locator: Locator, progression?: number): Promise<void> {
      return request(
        (id) => ({ kind: 'reader.setProgress', id, bookId, locator, progression }),
        (m): m is Extract<WorkerMessage, { kind: 'reader.progress.saved' }> =>
          m.kind === 'reader.progress.saved',
      ).then(() => undefined)
    },
    /**
     * Full-book streaming search: batches arrive via the listener; the
     * returned promise resolves when the whole book is scanned.
     */
    /**
     * Full-book streaming search. Returns the completion promise plus a
     * cancel() that stops the worker-side scan (supersession also cancels a
     * previous search automatically on the worker).
     */
    async search(
      bookId: string,
      query: string,
      onBatch: (results: SearchResult[]) => void,
    ): Promise<{ done: Promise<void>; cancel: () => void }> {
      const port = await getWorkerPort()
      const id = nextId++
      const listener = (message: WorkerMessage) => {
        if (
          message.kind === 'event' &&
          message.event.type === 'reader.searchBatch' &&
          message.event.id === id
        ) {
          onBatch(message.event.results)
        }
      }
      eventListeners.add(listener)
      const done = new Promise<void>((resolve, reject) => {
        pending.set(id, (message) => {
          if (message.kind === 'error') reject(new Error(message.message))
          else resolve()
        })
        port.postMessage({ kind: 'reader.search', id, bookId, query } satisfies WorkerRequest)
      })
      done.finally(() => eventListeners.delete(listener)).catch(() => {})
      return {
        done,
        cancel: () => {
          port.postMessage({ kind: 'reader.searchCancel', id } satisfies WorkerRequest)
        },
      }
    },
    /** Tells main a reader is open so app close flushes progress first. */
    setActive(active: boolean): void {
      ipcRenderer.send(IPC.readerActive, active)
    },
    /**
     * Main asks the reader to persist its final position before the window
     * closes. The callback's promise resolving acknowledges the flush.
     */
    onFlushProgress(listener: () => Promise<void>): () => void {
      const handler = () => {
        void listener().finally(() => ipcRenderer.send(IPC.progressFlushed))
      }
      ipcRenderer.on(IPC.flushProgress, handler)
      return () => ipcRenderer.removeListener(IPC.flushProgress, handler)
    },
  },
  annotations: {
    list(bookId: string): Promise<Annotation[]> {
      return request(
        (id) => ({ kind: 'annotations.list', id, bookId }),
        (m): m is Extract<WorkerMessage, { kind: 'annotations.list.result' }> =>
          m.kind === 'annotations.list.result',
      ).then((r) => r.annotations)
    },
    create(input: {
      bookId: string
      kind: 'highlight' | 'bookmark'
      locator: Locator
      color?: HighlightColor
      note?: string
    }): Promise<Annotation> {
      return request(
        (id) => ({ kind: 'annotations.create', id, input }),
        (m): m is Extract<WorkerMessage, { kind: 'annotations.create.result' }> =>
          m.kind === 'annotations.create.result',
      ).then((r) => r.annotation)
    },
    update(
      annotationId: string,
      patch: { color?: HighlightColor | null; note?: string | null },
    ): Promise<Annotation | null> {
      return request(
        (id) => ({ kind: 'annotations.update', id, annotationId, patch }),
        (m): m is Extract<WorkerMessage, { kind: 'annotations.update.result' }> =>
          m.kind === 'annotations.update.result',
      ).then((r) => r.annotation)
    },
    delete(annotationId: string): Promise<void> {
      return request(
        (id) => ({ kind: 'annotations.delete', id, annotationId }),
        (m): m is Extract<WorkerMessage, { kind: 'annotations.delete.result' }> =>
          m.kind === 'annotations.delete.result',
      ).then(() => undefined)
    },
  },
  sync: {
    setupServer(input: {
      type: ServerType
      name: string
      url: string
      username?: string
      secret: string
    }): Promise<{ server: ServerInfo; test: { ok: boolean; detail?: string } }> {
      return request(
        (id) => ({ kind: 'sync.setupServer', id, input }),
        (m): m is Extract<WorkerMessage, { kind: 'sync.setupServer.result' }> =>
          m.kind === 'sync.setupServer.result',
      ).then((r) => ({ server: r.server, test: r.test }))
    },
    removeServer(serverId: string): Promise<void> {
      return request(
        (id) => ({ kind: 'sync.removeServer', id, serverId }),
        (m): m is Extract<WorkerMessage, { kind: 'sync.removeServer.result' }> =>
          m.kind === 'sync.removeServer.result',
      ).then(() => undefined)
    },
    testConnection(serverId: string): Promise<{ ok: boolean; detail?: string }> {
      return request(
        (id) => ({ kind: 'sync.testConnection', id, serverId }),
        (m): m is Extract<WorkerMessage, { kind: 'sync.testConnection.result' }> =>
          m.kind === 'sync.testConnection.result',
      ).then((r) => ({ ok: r.ok, ...(r.detail ? { detail: r.detail } : {}) }))
    },
    syncNow(serverId: string): Promise<{ added: number; updated: number; error?: string }> {
      return request(
        (id) => ({ kind: 'sync.syncNow', id, serverId }),
        (m): m is Extract<WorkerMessage, { kind: 'sync.syncNow.result' }> =>
          m.kind === 'sync.syncNow.result',
      ).then((r) => ({
        added: r.added,
        updated: r.updated,
        ...(r.error ? { error: r.error } : {}),
      }))
    },
    download(bookId: string): Promise<Book | null> {
      return request(
        (id) => ({ kind: 'sync.download', id, bookId }),
        (m): m is Extract<WorkerMessage, { kind: 'sync.download.result' }> =>
          m.kind === 'sync.download.result',
      ).then((r) => r.book)
    },
    /**
     * Asks for a catalog book's cover. Deliberately returns nothing: the
     * cached cover arrives as a bookUpdated event, so a grid scrolling past
     * fifty cards never holds fifty promises open.
     */
    ensureCover(bookId: string): void {
      void notify((id) => ({ kind: 'sync.ensureCover', id, bookId }))
    },
    getState(): Promise<SyncState> {
      return request(
        (id) => ({ kind: 'sync.getState', id }),
        (m): m is Extract<WorkerMessage, { kind: 'sync.getState.result' }> =>
          m.kind === 'sync.getState.result',
      ).then((r) => r.state)
    },
    resolveConflict(bookId: string, serverId: string, choice: 'local' | 'server'): Promise<void> {
      return request(
        (id) => ({ kind: 'sync.resolveConflict', id, bookId, serverId, choice }),
        (m): m is Extract<WorkerMessage, { kind: 'sync.resolveConflict.result' }> =>
          m.kind === 'sync.resolveConflict.result',
      ).then(() => undefined)
    },
    onStateChanged(listener: (state: SyncState) => void): () => void {
      const handler = (message: WorkerMessage) => {
        if (message.kind === 'event' && message.event.type === 'syncState') {
          listener(message.event.state)
        }
      }
      eventListeners.add(handler)
      return () => eventListeners.delete(handler)
    },
  },
  secrets: {
    has(serverId: string): Promise<boolean> {
      return ipcRenderer.invoke(IPC.secretsHas, serverId)
    },
    clear(serverId: string): Promise<void> {
      return ipcRenderer.invoke(IPC.secretsClear, serverId)
    },
  },
  settings: {
    get(): Promise<Settings> {
      return ipcRenderer.invoke(IPC.settingsGet)
    },
    set(patch: Partial<Settings>): Promise<void> {
      return ipcRenderer.invoke(IPC.settingsSet, patch)
    },
    onChanged(listener: (settings: Settings) => void): () => void {
      const handler = (_e: IpcRendererEvent, settings: Settings) => listener(settings)
      ipcRenderer.on('liseur:settings-changed', handler)
      return () => ipcRenderer.removeListener('liseur:settings-changed', handler)
    },
  },
  app: {
    onNativeThemeChanged(listener: (dark: boolean) => void): () => void {
      const handler = (_e: IpcRendererEvent, dark: boolean) => listener(dark)
      ipcRenderer.on('liseur:native-theme-changed', handler)
      return () => ipcRenderer.removeListener('liseur:native-theme-changed', handler)
    },
    /** Native "Open EPUB" picker; chosen files go straight to the worker. */
    openEpubDialog(): Promise<void> {
      return ipcRenderer.invoke(IPC.openEpubDialog)
    },
    /** Native "Add folder" picker; the folder is scanned by the worker. */
    addFolderDialog(): Promise<void> {
      return ipcRenderer.invoke(IPC.addFolderDialog)
    },
    onMenu(listener: (action: 'settings' | 'search') => void): () => void {
      const handlers = (['settings', 'search'] as const).map((action) => {
        const channel = `liseur:menu:${action}`
        const handler = () => listener(action)
        ipcRenderer.on(channel, handler)
        return { channel, handler }
      })
      return () =>
        handlers.forEach(({ channel, handler }) => ipcRenderer.removeListener(channel, handler))
    },
  },
}

export type LiseurApi = typeof api

contextBridge.exposeInMainWorld('liseur', api)
