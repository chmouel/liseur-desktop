import type { BrowserWindow, WebContents } from 'electron'
import { getWorker } from './worker-host'

/**
 * Tracks which windows currently have an active reader, and lets a window
 * close wait for one final progress flush. Without this handshake, quitting
 * while reading could drop the last few seconds of progress: the renderer's
 * debounced save might still be in flight when the worker dies.
 *
 * Durability notes: the renderer also keeps a localStorage outbox of the
 * latest unsaved position (survives any crash), so this handshake is the
 * fast path, not the last resort. The wait ends on the renderer's ack, on
 * worker death (its exit releases the wait — nothing more can be saved), or
 * on a generous 5 s bound so a wedged process can never block quitting.
 */

const readerActive = new Set<number>()
const flushWaiters = new Map<number, () => void>()

const FLUSH_TIMEOUT_MS = 5000

export function markReaderActive(sender: WebContents, active: boolean): void {
  if (active) readerActive.add(sender.id)
  else readerActive.delete(sender.id)
}

export function markProgressFlushed(sender: WebContents): void {
  flushWaiters.get(sender.id)?.()
}

export function interceptCloseForFlush(win: BrowserWindow): void {
  let closing = false
  win.on('close', (event) => {
    if (closing || !readerActive.has(win.webContents.id)) return
    closing = true
    event.preventDefault()

    const finish = () => {
      clearTimeout(timeout)
      flushWaiters.delete(win.webContents.id)
      if (!win.isDestroyed()) win.destroy() // bypasses this close handler
    }
    // If the worker dies mid-flush there is nothing left to wait for.
    getWorker()?.once('exit', finish)
    const timeout = setTimeout(finish, FLUSH_TIMEOUT_MS)
    flushWaiters.set(win.webContents.id, finish)
    win.webContents.send('liseur:flush-progress')
  })
}
