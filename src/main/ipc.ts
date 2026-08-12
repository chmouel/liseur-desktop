import { BrowserWindow, MessageChannelMain, ipcMain, nativeTheme } from 'electron'
import { IPC } from '../shared/ipc/protocol'
import { readPersisted, writePersisted } from './window-state'
import { startWorker } from './worker-host'
import { openEpubDialog, addFolderDialog } from './dialogs'
import { markReaderActive, markProgressFlushed } from './reader-state'
import { sendAllCredentials, getWorker } from './worker-host'
import { secretStore } from './secrets'
import type { AppTheme, Settings } from '../shared/domain/types'

/**
 * Secure IPC wiring. The only generic thing here is port forwarding: the
 * renderer gets a MessagePort directly connected to the worker, and all
 * application data flows over that typed channel. Main handles settings and
 * window-adjacent concerns itself.
 */

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

function applyTheme(theme: AppTheme): void {
  nativeTheme.themeSource = theme
}

export function setupIpc(): void {
  // The renderer asks for a dedicated port; main creates a channel and hands
  // one end to each side. No data transits main after this.
  ipcMain.on(IPC.requestWorkerPort, (event) => {
    const worker = startWorker()
    const { port1, port2 } = new MessageChannelMain()
    worker.postMessage({ kind: 'connect' }, [port1])
    event.senderFrame?.postMessage(IPC.workerPort, null, [port2])
    // Re-push credentials on every connect (cheap; covers late secrets).
    sendAllCredentials(worker)
  })

  // Credential presence only — secrets never cross this bridge.
  ipcMain.handle(IPC.secretsHas, (_event, serverId: string) => secretStore.has(serverId))
  ipcMain.handle(IPC.secretsClear, (_event, serverId: string) => {
    secretStore.delete(serverId)
    getWorker()?.postMessage({ kind: 'server-credentials', serverId, headers: {} })
  })

  // Native pickers for ingestion (M3). Fire-and-forget: chosen paths go
  // straight to the worker; results stream back as bookAdded events.
  ipcMain.handle(IPC.openEpubDialog, () => openEpubDialog())
  ipcMain.handle(IPC.addFolderDialog, () => addFolderDialog())

  // Reader close handshake: the renderer marks when a reader is active and
  // acknowledges close-time flush requests (see reader-state.ts).
  ipcMain.on(IPC.readerActive, (event, active: unknown) => {
    markReaderActive(event.sender, active === true)
  })
  ipcMain.on(IPC.progressFlushed, (event) => markProgressFlushed(event.sender))

  ipcMain.handle(IPC.settingsGet, (): Settings => {
    const persisted = readPersisted()
    const settings: Settings = { theme: persisted.settings?.theme ?? 'system' }
    if (persisted.settings?.reader) settings.reader = persisted.settings.reader
    return settings
  })

  ipcMain.handle(IPC.settingsSet, (_event, patch: Partial<Settings>) => {
    const current = readPersisted()
    // Merge: a patch only replaces the keys it carries.
    const settings: Settings = {
      theme: patch.theme ?? current.settings?.theme ?? 'system',
      ...((patch.reader ?? current.settings?.reader)
        ? { reader: patch.reader ?? current.settings?.reader }
        : {}),
    }
    if (!writePersisted({ settings })) {
      // Settings are user state, not window bounds: failures must surface.
      console.error('[main] failed to persist settings')
      throw new Error('failed to persist settings')
    }
    applyTheme(settings.theme)
    broadcast('liseur:settings-changed', settings)
  })

  applyTheme(readPersisted().settings?.theme ?? 'system')

  nativeTheme.on('updated', () => {
    // Notify renderer so the app shell can react to OS theme changes.
    broadcast('liseur:native-theme-changed', nativeTheme.shouldUseDarkColors)
  })
}
