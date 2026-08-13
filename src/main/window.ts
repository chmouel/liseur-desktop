import { BrowserWindow, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWindowState, trackWindowState } from './window-state'
import { interceptCloseForFlush } from './reader-state'

const dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))

const MIN_WIDTH = 900
const MIN_HEIGHT = 600

export function createMainWindow(): BrowserWindow {
  const state = loadWindowState()

  const options: Electron.BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    // The menu bar is a strip of chrome above a page of text, and everything
    // in it has a keyboard shortcut. It stays out of the way until Alt asks
    // for it. (macOS is unaffected: the menu lives in the system bar there.)
    autoHideMenuBar: true,
    backgroundColor: state.dark ? '#17130e' : '#ffffff',
    webPreferences: {
      preload: join(dir, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  }

  // Frosted-glass window on macOS: the OS blurs whatever is behind the
  // window and shows it through the translucent surfaces the renderer
  // paints. It's a macOS-only compositor feature; other platforms fall
  // back to the solid backgroundColor above, and the renderer's own
  // backdrop-filter still frosts in-app layers there.
  if (process.platform === 'darwin') {
    options.vibrancy = 'sidebar'
    // Keep the vibrancy live even when the window is not focused; without
    // this macOS greys it out the moment you click away.
    options.visualEffectState = 'active'
    // A translucent surface needs the fill behind it to be transparent, or
    // the solid backgroundColor sits on top of the blur and hides it.
    options.backgroundColor = '#00000000'
  }

  if (state.x !== undefined) options.x = state.x
  if (state.y !== undefined) options.y = state.y

  const win = new BrowserWindow(options)

  // Show only when ready to paint — avoids a white flash without delaying
  // interactivity (the shell renders immediately, data streams in later).
  win.once('ready-to-show', () => win.show())

  trackWindowState(win)
  interceptCloseForFlush(win)

  // Security: never navigate the app window; external links go to OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(dir, '../renderer/index.html'))
  }

  return win
}
