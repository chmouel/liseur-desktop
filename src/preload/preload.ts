/**
 * Preload bridge — the only Node-adjacent code the renderer can see.
 *
 * Exposes a narrow, typed `window.liseur` API. There is no generic
 * invoke(channel, args) escape hatch: every operation is an explicit method
 * with typed parameters. Adding an operation = adding a typed method here.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc/protocol'
import type { WorkerMessage, WorkerRequest } from '../shared/ipc/protocol'
import type { Book, LibraryQuery, LibraryQueryResult, Settings } from '../shared/domain/types'

/** Lazily-created MessagePort straight to the worker. */
let workerPortPromise: Promise<MessagePort> | undefined

function getWorkerPort(): Promise<MessagePort> {
  if (!workerPortPromise) {
    workerPortPromise = new Promise((resolve) => {
      ipcRenderer.once(IPC.workerPort, (event: IpcRendererEvent) => {
        const [port] = event.ports
        if (!port) throw new Error('worker port missing from IPC message')
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
  if (!port.onmessage) {
    port.onmessage = (event) => {
      const message = event.data as WorkerMessage
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
  }
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
    onMenu(listener: (action: 'open-epub' | 'settings' | 'search') => void): () => void {
      const handlers = (['open-epub', 'settings', 'search'] as const).map((action) => {
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
