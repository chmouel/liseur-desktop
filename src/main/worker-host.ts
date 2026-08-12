import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  })

  worker.on('exit', (code) => {
    // The worker dying must not take the UI down; it will be respawned on
    // next port request.
    if (code !== 0) console.error(`[main] worker exited with code ${code}`)
    worker = undefined
  })

  return worker
}

export function getWorker(): UtilityProcess | undefined {
  return worker
}
