import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import type { LibraryFilter, LibrarySortKey } from '@shared/domain/types'
import { useLibraryStore } from './store'
import { VirtualBookGrid } from './VirtualBookGrid'
import { ContinueReading } from './ContinueReading'
import { SettingsScreen } from '../settings/SettingsScreen'
import { useTheme } from '../app/theme'

const FILTERS: readonly { id: LibraryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'downloaded', label: 'Downloaded' },
  { id: 'unread', label: 'Unread' },
  { id: 'archived', label: 'Archived' },
]

const SORTS: readonly { id: LibrarySortKey; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'title', label: 'Title' },
  { id: 'author', label: 'Author' },
  { id: 'added', label: 'Recently added' },
]

export function LibraryScreen(props: { onOpenBook: (bookId: string) => void }): JSX.Element {
  const store = useLibraryStore()
  const { theme, setTheme } = useTheme()

  const [searchOpen, setSearchOpen] = createSignal(false)
  const [selectedIndex, setSelectedIndex] = createSignal(-1)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  let searchInput: HTMLInputElement | undefined
  let gridEl: HTMLDivElement | undefined

  const openSearch = () => {
    setSearchOpen(true)
    // Focus on next microtask so the element exists; select-all mirrors the
    // Android behavior of reopening search with the query pre-selected.
    queueMicrotask(() => {
      searchInput?.focus()
      searchInput?.select()
    })
  }

  const closeSearch = () => {
    store.setSearchText('')
    setSearchOpen(false)
    gridEl?.focus()
  }

  const onSearchKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (store.searchText()) store.setSearchText('')
      else closeSearch()
      e.stopPropagation()
    }
  }

  const onGlobalKeydown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    const inField =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
    if (inField) return
    if (settingsOpen()) {
      if (e.key === 'Escape') setSettingsOpen(false)
      return
    }

    if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key === 'f')) {
      e.preventDefault()
      openSearch()
      return
    }
    if (e.key === 'Escape') {
      if (searchOpen()) closeSearch()
      else setSelectedIndex(-1)
      return
    }

    const count = store.books().length
    if (count === 0) return
    const columns = gridEl ? Math.max(1, Math.floor((gridEl.clientWidth + 20) / (128 + 20))) : 1

    switch (e.key) {
      case 'ArrowRight':
        setSelectedIndex((i) => Math.min(count - 1, i + 1))
        break
      case 'ArrowLeft':
        setSelectedIndex((i) => Math.max(0, i - 1))
        break
      case 'ArrowDown':
        setSelectedIndex((i) => Math.min(count - 1, i + columns))
        break
      case 'ArrowUp':
        setSelectedIndex((i) => Math.max(0, i - columns))
        break
      case 'Enter':
        if (selectedIndex() >= 0) openBook(selectedIndex())
        break
      default:
        return
    }
    e.preventDefault()
  }

  const openBook = (index: number) => {
    const book = store.books()[index]
    if (!book) return
    // Seeded placeholders have no file; remote shells download on open (M7).
    if (!book.localPath && !book.remoteId) return
    props.onOpenBook(book.id)
  }

  // Menu accelerators from main (Ctrl/Cmd+F, Ctrl/Cmd+,).
  window.liseur.app.onMenu((action) => {
    if (action === 'search') openSearch()
    if (action === 'settings') setSettingsOpen(true)
  })

  // Document-level key handling: Solid delegates element handlers, and keys
  // targeted at <body> (e.g. after a form closes) never pass through the
  // root div. The library screen unmounts while reading, so this listener
  // never fights the reader's.
  document.addEventListener('keydown', onGlobalKeydown)
  onCleanup(() => document.removeEventListener('keydown', onGlobalKeydown))

  return (
    <div class="library-screen">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">
            L
          </span>
          <span class="brand-name">Liseur</span>
        </div>

        <Show when={searchOpen()}>
          <input
            ref={(el) => {
              searchInput = el
            }}
            class="search-input"
            type="search"
            placeholder="Search books…"
            value={store.searchText()}
            onInput={(e) => store.setSearchText(e.currentTarget.value)}
            onKeyDown={onSearchKeydown}
            aria-label="Search books"
          />
        </Show>

        <div class="topbar-actions">
          <button
            type="button"
            class="icon-button"
            onClick={openSearch}
            aria-label="Search"
            title="Search (/)"
          >
            ⌕
          </button>
          <button
            type="button"
            class="icon-button"
            onClick={() => setTheme(theme() === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme"
            title={`Theme: ${theme()}`}
          >
            {theme() === 'dark' ? '☾' : '☀'}
          </button>
          <button
            type="button"
            class="icon-button"
            onClick={() => void window.liseur.app.openEpubDialog()}
            aria-label="Add books"
            title="Open EPUB… (Ctrl/Cmd+O)"
          >
            +
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Settings"
            title="Settings (Ctrl/Cmd+,)"
            onClick={() => setSettingsOpen(true)}
          >
            ⋮
          </button>
        </div>
      </header>

      <Show when={settingsOpen()}>
        <SettingsScreen onClose={() => setSettingsOpen(false)} />
      </Show>

      <div class="filter-bar">
        <div class="chips" role="tablist" aria-label="Library filters">
          <For each={FILTERS}>
            {(f) => (
              <button
                type="button"
                role="tab"
                aria-selected={store.filter() === f.id}
                class="chip"
                classList={{ active: store.filter() === f.id }}
                onClick={() => store.setFilter(f.id)}
              >
                {f.label}
              </button>
            )}
          </For>
        </div>

        <div class="sort-controls">
          <For each={SORTS}>
            {(s) => (
              <button
                type="button"
                class="sort-button"
                classList={{ active: store.sort() === s.id }}
                onClick={() => store.setSort(s.id)}
                aria-pressed={store.sort() === s.id}
              >
                {s.label}
                {store.sort() === s.id && (
                  <span aria-hidden="true">{store.direction() === 'asc' ? ' ↑' : ' ↓'}</span>
                )}
              </button>
            )}
          </For>
        </div>
      </div>

      <main class="library-main">
        <Show when={store.filter() === 'all' && !store.searchText()}>
          <ContinueReading
            book={store.continueReadingBook()}
            onOpen={() => {
              const book = store.continueReadingBook()
              if (book?.localPath) props.onOpenBook(book.id)
            }}
          />
        </Show>

        <Show when={!store.loading() && store.books().length === 0}>
          <p class="empty-state">
            {store.searchText() ? `No books match “${store.searchText()}”.` : 'No books here yet.'}
          </p>
        </Show>

        <VirtualBookGrid
          books={store.books}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onOpen={openBook}
          gridRef={(el) => (gridEl = el)}
        />
      </main>
    </div>
  )
}
