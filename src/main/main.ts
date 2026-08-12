import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './window'
import { setupMenu } from './menu'
import { startWorker } from './worker-host'
import { setupIpc } from './ipc'

// Single-instance: focus the existing window instead of spawning another.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // Order matters for perceived startup: create the window first so the
    // shell paints as early as possible; the worker boots in parallel and
    // the renderer connects to it asynchronously.
    setupIpc()
    createMainWindow()
    setupMenu()
    startWorker()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
