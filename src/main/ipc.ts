import { BrowserWindow, MessageChannelMain, ipcMain, nativeTheme } from 'electron'
import { IPC } from '../shared/ipc/protocol'
import { readPersisted, writePersisted } from './window-state'
import { startWorker } from './worker-host'
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
  })

  ipcMain.handle(IPC.settingsGet, (): Settings => {
    const persisted = readPersisted()
    return { theme: persisted.settings?.theme ?? 'system' }
  })

  ipcMain.handle(IPC.settingsSet, (_event, patch: Partial<Settings>) => {
    const current = readPersisted()
    const theme = patch.theme ?? current.settings?.theme ?? 'system'
    writePersisted({ settings: { theme } })
    applyTheme(theme)
    broadcast('liseur:settings-changed', { theme } satisfies Settings)
  })

  applyTheme(readPersisted().settings?.theme ?? 'system')

  nativeTheme.on('updated', () => {
    // Notify renderer so the app shell can react to OS theme changes.
    broadcast('liseur:native-theme-changed', nativeTheme.shouldUseDarkColors)
  })
}
