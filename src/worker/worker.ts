import { type MessagePortMain } from 'electron'
import type { WorkerMessage, WorkerRequest } from '../shared/ipc/protocol'
import { LibraryService } from './library/library-service'

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
 */

const library = new LibraryService()

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

parentPort?.on('message', (event: { ports: readonly MessagePortMain[] }) => {
  const [port] = event.ports
  if (!port) return
  ports.add(port)
  port.on('message', (messageEvent: { data: WorkerRequest }) => {
    handleRequest(port, messageEvent.data)
  })
  port.on('close', () => ports.delete(port))
  port.start()
})

export function broadcastEvent(message: WorkerMessage): void {
  for (const port of ports) send(port, message)
}
