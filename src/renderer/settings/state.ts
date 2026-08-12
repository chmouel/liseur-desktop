import { createSignal } from 'solid-js'

/**
 * Whether the settings panel is up.
 *
 * It belongs to the application rather than to the shelf. It used to live
 * inside the library screen, which is unmounted while a book is open — so
 * Ctrl+, did nothing at all once you started reading, and the panel could
 * only be reached by leaving the book first.
 *
 * The screens underneath read this too: both listen for keys on the
 * document, and a page must not turn behind a settings panel.
 */
const [settingsOpen, setSettingsOpen] = createSignal(false)

export { settingsOpen }

export function openSettings(): void {
  setSettingsOpen(true)
}

export function closeSettings(): void {
  setSettingsOpen(false)
}
