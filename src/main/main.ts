import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './window'
import { setupMenu } from './menu'
import { startWorker } from './worker-host'
import { setupIpc } from './ipc'
import { registerCoverScheme, handleCoverRequests } from './covers'
import { registerBookScheme, handleBookRequests } from './book-content'

// A custom data dir must own Electron's userData too, or the instance lock,
// caches and the GPU profile stay shared with the real app — an e2e run
// would then quit instantly against a running instance.
if (process.env.LISEUR_DATA_DIR) app.setPath('userData', process.env.LISEUR_DATA_DIR)

// Chromium only auto-detects a keyring on GNOME and KDE; everywhere else it
// silently degrades to an unencrypted store and safeStorage reports itself
// unavailable. Ask for the Secret Service explicitly (it falls back the same
// way if libsecret is missing, so this is never worse than the default).
if (process.platform === 'linux' && !/kde|plasma/i.test(process.env.XDG_CURRENT_DESKTOP ?? '')) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

// Scheme privileges must be registered before app ready.
registerCoverScheme()
registerBookScheme()

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
    handleCoverRequests()
    handleBookRequests()
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
