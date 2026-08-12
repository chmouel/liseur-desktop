import { nativeTheme, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths'

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
  settings?: {
    theme?: 'system' | 'light' | 'dark'
    reader?: { fontSize: number; columns: 1 | 2 } | undefined
  }
}

const DEFAULTS: WindowState = { width: 1280, height: 800, dark: false }

function stateFile(): string {
  // Lives in the data dir (LISEUR_DATA_DIR override) so e2e runs are
  // hermetic and never touch the real settings.
  return join(dataDir(), 'window-state.json')
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

export function writePersisted(patch: Partial<PersistedState>): boolean {
  cached = { ...readPersisted(), ...patch }
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(cached))
    return true
  } catch {
    // Callers decide: window bounds are best-effort, settings are not.
    return false
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
