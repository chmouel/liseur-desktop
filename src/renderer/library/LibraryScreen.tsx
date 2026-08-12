import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import type { LibraryFilter, LibrarySortKey } from '@shared/domain/types'
import { useLibraryStore } from './store'
import { VirtualBookGrid } from './VirtualBookGrid'
import { ContinueReading } from './ContinueReading'
import { SettingsScreen } from '../settings/SettingsScreen'
import { StatsScreen } from '../stats/StatsScreen'
import { useTheme } from '../app/theme'
import { computeColumns, GRID_CARD_WIDTH, GRID_GAP, GRID_ROW_HEIGHT } from './virtualize'
import { createVimSession, times, vimMode } from '../vim/vim'
import { LIBRARY_BINDINGS, type LibraryCommand } from '../vim/keymap'
import { VimHelp, VimPending } from '../vim/VimHelp'
import brandTile from '../assets/brand-tile.webp'
import brandTileDark from '../assets/brand-tile-dark.webp'

const SORTS: readonly { id: LibrarySortKey; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'title', label: 'Title' },
  { id: 'author', label: 'Author' },
  { id: 'added', label: 'Recently added' },
]

export function LibraryScreen(props: { onOpenBook: (bookId: string) => void }): JSX.Element {
  const store = useLibraryStore()
  const { theme, dark, setTheme } = useTheme()

  const [searchOpen, setSearchOpen] = createSignal(false)
  const [selectedIndex, setSelectedIndex] = createSignal(-1)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [statsOpen, setStatsOpen] = createSignal(false)
  const [sortMenuOpen, setSortMenuOpen] = createSignal(false)
  const [helpOpen, setHelpOpen] = createSignal(false)
  let searchInput: HTMLInputElement | undefined
  let gridEl: HTMLDivElement | undefined
  const vim = createVimSession<LibraryCommand>(LIBRARY_BINDINGS)

  // Chips a library has nothing to say with are left off rather than shown
  // inert: with no server every book is downloaded, and with nothing put
  // away the archive drawer is empty.
  const filters = (): { id: LibraryFilter; label: string }[] => {
    const list: { id: LibraryFilter; label: string }[] = [{ id: 'all', label: 'All' }]
    if (store.hasServer()) list.push({ id: 'downloaded', label: 'Downloaded' })
    list.push({ id: 'unread', label: 'Unread' })
    if (store.archivedCount() > 0 || store.filter() === 'archived') {
      list.push({ id: 'archived', label: 'Archived' })
    }
    return list
  }

  const sortLabel = () => SORTS.find((s) => s.id === store.sort())?.label ?? 'Recent'
  const directionArrow = () => (store.direction() === 'asc' ? '↑' : '↓')

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
    if (helpOpen()) {
      // While the sheet is up it owns the keyboard: it is a list of keys, so
      // acting on one behind it would be a trap.
      if (e.key === 'Escape' || e.key === 'q' || e.key === '?') {
        e.preventDefault()
        setHelpOpen(false)
      }
      return
    }
    if (settingsOpen()) {
      if (e.key === 'Escape' || (vimMode() && e.key === 'q')) setSettingsOpen(false)
      return
    }
    if (statsOpen()) {
      if (e.key === 'Escape' || (vimMode() && e.key === 'q')) setStatsOpen(false)
      return
    }
    if (sortMenuOpen() && e.key === 'Escape') {
      setSortMenuOpen(false)
      return
    }

    // Vim keys go first and only claim what they are bound to; everything
    // else — arrows, Enter, Escape, the menu chords — falls through
    // untouched, exactly as it behaves with vim mode off.
    if (vim.handle(e, runVimCommand)) return

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

    switch (e.key) {
      case 'ArrowRight':
        setSelectedIndex((i) => Math.min(count - 1, i + 1))
        break
      case 'ArrowLeft':
        setSelectedIndex((i) => Math.max(0, i - 1))
        break
      case 'ArrowDown':
        setSelectedIndex((i) => Math.min(count - 1, i + gridColumns()))
        break
      case 'ArrowUp':
        setSelectedIndex((i) => Math.max(0, i - gridColumns()))
        break
      case 'Enter':
        if (selectedIndex() >= 0) openBook(selectedIndex())
        break
      default:
        return
    }
    e.preventDefault()
  }

  // --- vim mode ------------------------------------------------------------

  /** The grid's own column arithmetic, so the keyboard and the layout agree. */
  const gridColumns = () =>
    gridEl ? computeColumns(gridEl.clientWidth, GRID_CARD_WIDTH, GRID_GAP) : 1

  /** Whole rows that fit on screen — what a screenful means to the keyboard. */
  const gridRows = () =>
    gridEl ? Math.max(1, Math.floor(gridEl.clientHeight / GRID_ROW_HEIGHT)) : 1

  /** Moves the selection, landing on the first book when nothing is picked. */
  const moveSelection = (delta: number) => {
    const count = store.books().length
    if (count === 0) return
    setSelectedIndex((i) => (i < 0 ? 0 : Math.min(count - 1, Math.max(0, i + delta))))
  }

  const cycle = <T,>(values: readonly T[], current: T, delta: number): T | undefined => {
    if (values.length === 0) return undefined
    const index = values.indexOf(current)
    return values[
      ((((index === -1 ? 0 : index) + delta) % values.length) + values.length) % values.length
    ]
  }

  function runVimCommand(command: LibraryCommand, count: number | null): void {
    const books = store.books()
    switch (command) {
      case 'left':
        times(count, () => moveSelection(-1))
        break
      case 'right':
        times(count, () => moveSelection(1))
        break
      case 'down':
        times(count, () => moveSelection(gridColumns()))
        break
      case 'up':
        times(count, () => moveSelection(-gridColumns()))
        break
      case 'rowStart':
        if (selectedIndex() >= 0) setSelectedIndex((i) => i - (i % gridColumns()))
        break
      case 'rowEnd':
        if (selectedIndex() >= 0) {
          setSelectedIndex((i) =>
            Math.min(books.length - 1, i - (i % gridColumns()) + gridColumns() - 1),
          )
        }
        break
      case 'first':
        if (books.length > 0) setSelectedIndex(0)
        break
      case 'last':
        // `12G` is the twelfth book, as `12G` is the twelfth line.
        if (books.length > 0) {
          setSelectedIndex(count === null ? books.length - 1 : Math.min(books.length, count) - 1)
        }
        break
      case 'halfPageDown':
        moveSelection(gridColumns() * Math.max(1, Math.floor(gridRows() / 2)))
        break
      case 'halfPageUp':
        moveSelection(-gridColumns() * Math.max(1, Math.floor(gridRows() / 2)))
        break
      case 'open':
        if (selectedIndex() >= 0) openBook(selectedIndex())
        break
      case 'continueReading': {
        const book = store.continueReadingBook()
        if (book?.localPath) props.onOpenBook(book.id)
        break
      }
      case 'addBooks':
        void window.liseur.app.openEpubDialog()
        break
      case 'search':
        openSearch()
        break
      case 'filterNext':
      case 'filterPrev': {
        const ids = filters().map((f) => f.id)
        const next = cycle(ids, store.filter(), command === 'filterNext' ? 1 : -1)
        if (next) store.setFilter(next)
        break
      }
      case 'sortNext':
      case 'sortPrev': {
        const ids = SORTS.map((s) => s.id)
        const next = cycle(ids, store.sort(), command === 'sortNext' ? 1 : -1)
        // setSort on the current key would flip the direction instead; the
        // sorts cycle here, and `r` is the one that reverses.
        if (next && next !== store.sort()) store.setSort(next)
        break
      }
      case 'sortReverse':
        store.setSort(store.sort())
        break
      case 'stats':
        setStatsOpen(true)
        break
      case 'settings':
        setSettingsOpen(true)
        break
      case 'help':
        setHelpOpen(true)
        break
      case 'closeOverlay':
        if (sortMenuOpen()) setSortMenuOpen(false)
        else if (searchOpen()) closeSearch()
        else setSelectedIndex(-1)
        break
    }
  }

  const openBook = (index: number) => {
    const book = store.books()[index]
    if (!book) return
    // Nothing to open until a book has a file; remote books fetch on open.
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
  onCleanup(() => {
    document.removeEventListener('keydown', onGlobalKeydown)
    vim.reset() // drops the sequence timer with the screen
  })

  return (
    <div class="library-screen">
      <header class="topbar">
        <button
          type="button"
          class="brand"
          // The shelf can be thousands of rows long; the mark is the way
          // back to the top, as it is on the phone.
          onClick={() => gridEl?.scrollTo({ top: 0 })}
          title="Back to the top"
        >
          <img
            class="brand-tile"
            src={dark() ? brandTileDark : brandTile}
            alt=""
            width={200}
            height={150}
            draggable={false}
          />
          <span class="brand-text">
            <span class="brand-name">Liseur</span>
            <Show when={!store.loading() && store.totalCount() > 0}>
              <span class="brand-count">
                {store.totalCount().toLocaleString()} {store.totalCount() === 1 ? 'book' : 'books'}
              </span>
            </Show>
          </span>
        </button>

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
            onClick={() => setStatsOpen(true)}
            aria-label="Reading statistics"
            title="Reading statistics"
          >
            {/* Drawn rather than typed: no character in a UI font reads as
                a chart at this size, and the box ones look like a blank. */}
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <rect x="4" y="13" width="4" height="7" rx="1" fill="currentColor" />
              <rect x="10" y="8" width="4" height="12" rx="1" fill="currentColor" />
              <rect x="16" y="4" width="4" height="16" rx="1" fill="currentColor" />
            </svg>
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
            class="icon-button primary"
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

      <Show when={statsOpen()}>
        <StatsScreen onClose={() => setStatsOpen(false)} />
      </Show>

      <Show when={helpOpen()}>
        <VimHelp scope="library" onClose={() => setHelpOpen(false)} />
      </Show>
      <VimPending pending={vim.pending} />

      <div class="filter-bar">
        <div class="chips" role="tablist" aria-label="Library filters">
          <For each={filters()}>
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

        <div class="sort-menu">
          <button
            type="button"
            class="sort-trigger"
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen()}
            onClick={() => setSortMenuOpen((open) => !open)}
          >
            {sortLabel()}
            <span class="sort-direction" aria-hidden="true">
              {directionArrow()}
            </span>
          </button>
          <Show when={sortMenuOpen()}>
            <div
              class="sort-menu-backdrop"
              onClick={() => setSortMenuOpen(false)}
              aria-hidden="true"
            />
            <div class="sort-menu-items" role="menu">
              <For each={SORTS}>
                {(s) => (
                  <button
                    type="button"
                    role="menuitem"
                    class="sort-menu-item"
                    classList={{ active: store.sort() === s.id }}
                    onClick={() => {
                      // Picking the order you are already in flips it; the
                      // row would otherwise be dead under the pointer.
                      store.setSort(s.id)
                      setSortMenuOpen(false)
                    }}
                  >
                    <span>{s.label}</span>
                    <Show when={store.sort() === s.id}>
                      <span aria-hidden="true">{directionArrow()}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
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
