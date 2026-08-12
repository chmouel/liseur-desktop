import { onMount, type JSX } from 'solid-js'
import { initTheme } from './theme'
import { initLibrary } from '../library/store'
import { LibraryScreen } from '../library/LibraryScreen'
import { observeLongTasks, perf } from '../perf/perf'

/**
 * Application shell. Renders immediately — the library streams in
 * asynchronously from the worker, so first paint is never blocked on data.
 */
export function App(): JSX.Element {
  const done = perf.mark('app shell render')

  onMount(() => {
    initTheme()
    initLibrary()
    observeLongTasks()
    done()
  })

  return <LibraryScreen />
}
