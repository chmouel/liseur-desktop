import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir } from './paths'
import { secretStore } from './secrets'
import type { WorkerToMainMessage } from '../shared/ipc/protocol'

const dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))

/**
 * The worker is an Electron utilityProcess: an isolated Node context that
 * owns all expensive work (fake dataset now; SQLite, EPUB parsing, scanning
 * and server sync later). Main only forwards MessagePorts — it never touches
 * the data itself.
 */

let worker: UtilityProcess | undefined

export function startWorker(): UtilityProcess {
  if (worker && worker.pid !== undefined) return worker

  worker = utilityProcess.fork(join(dir, 'worker.cjs'), [], {
    serviceName: 'liseur-worker',
    // Default (empty) stdio keeps worker logs out of the user's terminal in
    // production; inherit in dev for debugging.
    stdio: app.isPackaged ? 'ignore' : 'inherit',
    env: {
      ...process.env,
      // The worker cannot reach app.getPath; main tells it where the
      // database lives. LISEUR_DATA_DIR overrides it (used by e2e tests for
      // a hermetic, throwaway library).
      LISEUR_DATA_DIR: dataDir(),
      // The 10,000-book fake dataset exists to measure the library screen
      // against its perf budget; it is never seeded unless asked for. Real
      // EPUB ingestion has been the way books arrive since M3, and seeding
      // by default meant a fresh install opened onto a library full of
      // books that do not exist.
      LISEUR_SEED_FAKE_LIBRARY: process.env.LISEUR_SEED_FAKE_LIBRARY ?? '0',
    },
  })

  worker.on('exit', (code) => {
    // The worker dying must not take the UI down; it will be respawned on
    // next port request.
    if (code !== 0) console.error(`[main] worker exited with code ${code}`)
    worker = undefined
  })

  // Secrets flow: worker → main (store in keychain), main → worker (auth
  // headers, in memory only).
  worker.on('message', (message: WorkerToMainMessage) => {
    if (!message || typeof message !== 'object' || !('kind' in message)) return
    try {
      if (message.kind === 'store-secret') {
        secretStore.set(message.serverId, { headers: message.headers, extra: message.extra })
        sendAllCredentials(worker!)
        worker?.postMessage({
          kind: 'secret-stored',
          requestId: message.requestId,
          serverId: message.serverId,
        })
      } else if (message.kind === 'clear-secret') {
        secretStore.delete(message.serverId)
      }
    } catch (err) {
      // A failing keychain must neither crash main nor fake success: the
      // worker's setup flow reports the error to the user.
      console.error(`[main] secret store error: ${(err as Error).message}`)
      if (message.kind === 'store-secret') {
        worker?.postMessage({
          kind: 'secret-stored',
          requestId: message.requestId,
          serverId: message.serverId,
          error: (err as Error).message,
        })
      }
    }
  })
  worker.on('spawn', () => sendAllCredentials(worker!))

  return worker
}

/** Pushes all stored credentials to the worker (spawn + each port connect). */
export function sendAllCredentials(target: UtilityProcess): void {
  for (const [serverId, credential] of Object.entries(secretStore.all())) {
    target.postMessage({
      kind: 'server-credentials',
      serverId,
      headers: credential.headers,
      ...(credential.extra ? { extra: credential.extra } : {}),
    })
  }
}

export function getWorker(): UtilityProcess | undefined {
  return worker
}
