import { createSignal, onMount, Show, type JSX } from 'solid-js'
import { initTheme } from './theme'
import { initLibrary, useLibraryStore } from '../library/store'
import { LibraryScreen } from '../library/LibraryScreen'
import { ReaderScreen } from '../reader/ReaderScreen'
import { observeLongTasks, perf } from '../perf/perf'

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
