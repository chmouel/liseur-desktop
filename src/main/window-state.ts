import { app, nativeTheme, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tiny synchronous JSON persistence for window bounds and app settings.
 *
 * This is the ONLY sanctioned synchronous filesystem use in the app: it runs
 * once in main before the window exists (a few hundred bytes), and saves are
 * debounced. Everything else must go through the worker.
 */

interface WindowState {
  width: number
  height: number
  x?: number | undefined
  y?: number | undefined
  dark: boolean
}

interface PersistedState {
  window?: Partial<WindowState>
  settings?: { theme?: 'system' | 'light' | 'dark' }
}

const DEFAULTS: WindowState = { width: 1280, height: 800, dark: false }

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

let cached: PersistedState | undefined

export function readPersisted(): PersistedState {
  if (cached) return cached
  try {
    cached = JSON.parse(readFileSync(stateFile(), 'utf8')) as PersistedState
  } catch {
    cached = {}
  }
  return cached
}

export function writePersisted(patch: Partial<PersistedState>): void {
  cached = { ...readPersisted(), ...patch }
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(cached))
  } catch {
    // Losing window bounds is not worth surfacing an error.
  }
}

export function loadWindowState(): WindowState {
  const persisted = readPersisted().window ?? {}
  return {
    ...DEFAULTS,
    ...persisted,
    dark: nativeTheme.shouldUseDarkColors,
  }
}

export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined
  const save = () => {
    if (win.isDestroyed() || win.isMinimized()) return
    const bounds = win.getBounds()
    writePersisted({
      window: { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y },
    })
  }
  const debounced = () => {
    clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  win.on('resize', debounced)
  win.on('move', debounced)
  win.on('close', save)
}
