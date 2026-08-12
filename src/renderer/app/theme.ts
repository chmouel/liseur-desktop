import { createEffect, createSignal, onCleanup } from 'solid-js'
import type { AppTheme, Settings } from '../../shared/domain/types'

/**
 * App theme state. 'system' follows the OS via nativeTheme updates pushed
 * from main; explicit light/dark override it. The applied theme is a plain
 * data attribute — all styling flows through CSS variables.
 */

const [theme, setThemeSignal] = createSignal<AppTheme>('system')
const [osDark, setOsDark] = createSignal(false)

function applyDomTheme(): void {
  const t = theme()
  const dark = t === 'dark' || (t === 'system' && osDark())
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

export function useTheme(): {
  theme: () => AppTheme
  setTheme: (t: AppTheme) => void
} {
  return { theme, setTheme }
}

function setTheme(t: AppTheme): void {
  setThemeSignal(t)
  applyDomTheme()
  // Persist through main — fire and forget, never block UI on it.
  void window.liseur.settings.set({ theme: t })
}

/** Call once at app startup. Applies the persisted theme immediately. */
export function initTheme(): void {
  createEffect(applyDomTheme)

  const offSettings = window.liseur.settings.onChanged((s: Settings) => {
    setThemeSignal(s.theme)
  })
  const offNative = window.liseur.app.onNativeThemeChanged((dark: boolean) => {
    setOsDark(dark)
  })

  void window.liseur.settings.get().then((s) => setThemeSignal(s.theme))
  setOsDark(window.matchMedia('(prefers-color-scheme: dark)').matches)
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onMq = (e: MediaQueryListEvent) => setOsDark(e.matches)
  mq.addEventListener('change', onMq)

  onCleanup(() => {
    offSettings()
    offNative()
    mq.removeEventListener('change', onMq)
  })
}
