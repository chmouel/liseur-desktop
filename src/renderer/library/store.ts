import { createSignal } from 'solid-js'
import type {
  Book,
  LibraryFilter,
  LibraryQueryResult,
  LibrarySortKey,
  SortDirection,
} from '@shared/domain/types'
import { perf } from '../perf/perf'

/**
 * Renderer-side library store.
 *
 * The search input state is strictly LOCAL — typing updates a signal on the
 * same frame, never waiting for the worker. Only the debounced query result
 * comes back asynchronously. Stale results are dropped via a generation
 * counter so an out-of-order response can never clobber newer state.
 */

export const DEFAULT_QUERY = {
  filter: 'all' as LibraryFilter,
  sort: 'recent' as LibrarySortKey,
  direction: 'desc' as SortDirection,
}

const [searchText, setSearchTextSignal] = createSignal('')
const [filter, setFilterSignal] = createSignal<LibraryFilter>(DEFAULT_QUERY.filter)
const [sort, setSortSignal] = createSignal<LibrarySortKey>(DEFAULT_QUERY.sort)
const [direction, setDirectionSignal] = createSignal<SortDirection>(DEFAULT_QUERY.direction)

const [books, setBooks] = createSignal<Book[]>([])
const [totalCount, setTotalCount] = createSignal(0)
const [archivedCount, setArchivedCount] = createSignal(0)
const [hasServer, setHasServer] = createSignal(false)
const [loading, setLoading] = createSignal(true)
const [continueReadingBook, setContinueReadingBook] = createSignal<Book | null>(null)

let generation = 0
let searchDebounce: ReturnType<typeof setTimeout> | undefined

export function useLibraryStore() {
  return {
    searchText,
    filter,
    sort,
    direction,
    books,
    totalCount,
    archivedCount,
    hasServer,
    loading,
    continueReadingBook,
    setSearchText,
    setFilter,
    setSort,
    refresh,
    refreshContinueReading,
  }
}

function buildQuery() {
  return { filter: filter(), sort: sort(), direction: direction(), search: searchText() }
}

function setSearchText(value: string): void {
  // Same-frame update; the worker query is debounced separately.
  setSearchTextSignal(value)
  clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => void refresh(), 80)
}

function setFilter(f: LibraryFilter): void {
  setFilterSignal(f)
  void refresh()
}

function setSort(s: LibrarySortKey): void {
  // Activating the current sort flips direction, matching the Android app.
  if (sort() === s) {
    setDirectionSignal((d) => (d === 'asc' ? 'desc' : 'asc'))
  } else {
    setSortSignal(s)
    setDirectionSignal(s === 'title' || s === 'author' ? 'asc' : 'desc')
  }
  void refresh()
}

async function refresh(): Promise<void> {
  const myGeneration = ++generation
  const done = perf.mark('library query')
  try {
    const result: LibraryQueryResult = await window.liseur.library.query(buildQuery())
    if (myGeneration !== generation) return // stale — a newer query is in flight
    setBooks(result.books)
    setTotalCount(result.totalCount)
    setArchivedCount(result.archivedCount)
    setLoading(false)
    done()
  } catch (err) {
    if (myGeneration === generation) setLoading(false)
    console.error('library query failed', err)
  }
}

async function refreshContinueReading(): Promise<void> {
  try {
    setContinueReadingBook(await window.liseur.library.continueReading())
  } catch (err) {
    console.error('continueReading failed', err)
  }
}

let bookAddedDebounce: ReturnType<typeof setTimeout> | undefined

export function initLibrary(): void {
  void refresh()
  void refreshContinueReading()
  // The Downloaded chip is only meaningful once some books live on a server
  // and some do not; with local files alone it selects everything.
  window.liseur.sync.onStateChanged((state) => setHasServer(state.servers.length > 0))
  void window.liseur.sync.getState().then((state) => setHasServer(state.servers.length > 0))
  window.liseur.library.onBookUpdated((book) => {
    setBooks((current) => {
      const index = current.findIndex((b) => b.id === book.id)
      if (index === -1) return current
      const next = current.slice()
      next[index] = book
      return next
    })
  })
  // Ingestion reports books one at a time; a scan can add hundreds, so
  // collapse bursts into a single re-query instead of inserting per event
  // (which would also need filter/sort re-evaluation client-side).
  window.liseur.library.onBookAdded(() => {
    clearTimeout(bookAddedDebounce)
    bookAddedDebounce = setTimeout(() => {
      void refresh()
      void refreshContinueReading()
    }, 150)
  })
}
