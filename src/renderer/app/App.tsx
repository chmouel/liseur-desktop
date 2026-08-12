import { createSignal, onMount, Show, type JSX } from 'solid-js'
import { initTheme } from './theme'
import { initLibrary, useLibraryStore } from '../library/store'
import { LibraryScreen } from '../library/LibraryScreen'
import { ReaderScreen } from '../reader/ReaderScreen'
import { observeLongTasks, perf } from '../perf/perf'

/**
 * Ask the worker for anything new on the servers when the window comes back
 * to the front. Books added to a server used to appear only after a
 * restart, because the catalog was pulled once at startup.
 *
 * Coming back to the window is the moment a person is about to look at the
 * shelf, so it is the moment worth spending a request on. An idle app in
 * the background does nothing at all — no timer, nothing to wake the
 * machine — and the worker ignores a server it synced recently, so
 * flicking between windows is free.
 */
function watchForNewServerBooks(): void {
  const refresh = (): void => {
    if (document.visibilityState === 'hidden') return
    void window.liseur.sync.refreshStale().catch(() => {})
  }
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
}

/**
 * Application shell. Renders immediately — the library streams in
 * asynchronously from the worker, so first paint is never blocked on data.
 * View switching is a plain signal: library or reader (a book id).
 */
export function App(): JSX.Element {
  const done = perf.mark('app shell render')
  const [openBookId, setOpenBookId] = createSignal<string | null>(null)
  const library = useLibraryStore()

  onMount(() => {
    initTheme()
    initLibrary()
    observeLongTasks()
    watchForNewServerBooks()
    done()
  })

  return (
    <Show when={openBookId()} fallback={<LibraryScreen onOpenBook={(id) => setOpenBookId(id)} />}>
      {(bookId) => (
        <ReaderScreen
          bookId={bookId()}
          onClose={() => {
            setOpenBookId(null)
            // Progress changed while reading: refresh what the user sees.
            void library.refresh()
            void library.refreshContinueReading()
          }}
        />
      )}
    </Show>
  )
}
