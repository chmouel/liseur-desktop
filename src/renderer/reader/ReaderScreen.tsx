import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js'
import {
  HIGHLIGHT_COLORS,
  type Annotation,
  type HighlightColor,
  type Locator,
  type OpenedBook,
  type ReaderPreferences,
  type SearchResult,
} from '@shared/domain/types'
import {
  ColumnEngine,
  DEFAULT_READER_PREFERENCES,
  type PageInfo,
  type ReaderEngine,
  type SelectionAnchor,
} from './engine'
import {
  readerMeasurePx,
  clampFontSize,
  clampMeasure,
  marginPresetFor,
  MARGIN_PRESETS,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_MEASURE,
  MAX_MEASURE,
  type MarginPreset,
} from './reader-theme'

/** Margin presets in the order they read: most text to least. */
const MARGIN_NAMES = ['narrow', 'normal', 'wide'] as const
const MARGIN_LABELS: Record<MarginPreset, string> = {
  narrow: 'Narrow',
  normal: 'Normal',
  wide: 'Wide',
}
import { computeRange } from '../library/virtualize'
import { normalizeText } from './anchoring'

/**
 * The M5 reader shell. Chrome auto-hides into "hidden reading mode" after a
 * few idle seconds (mouse movement, a key press, or a center tap brings it
 * back). Visual-first rules apply: page turns never wait on persistence;
 * progress saves are leading-edge + debounced, mirrored to a localStorage
 * outbox, and flushed through a close-time handshake with main.
 */

const PROGRESS_SAVE_DEBOUNCE_MS = 400
const CHROME_HIDE_DELAY_MS = 2500

export function ReaderScreen(props: { bookId: string; onClose: () => void }): JSX.Element {
  // Capture once: props are reactive in Solid, so reading them after
  // unmount (the async close path) throws. The id is fixed per mount.
  const bookId = props.bookId
  const [opened, setOpened] = createSignal<OpenedBook | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [position, setPosition] = createSignal<PageInfo | null>(null)
  const [prefs, setPrefs] = createSignal<ReaderPreferences>(DEFAULT_READER_PREFERENCES)
  const [tocOpen, setTocOpen] = createSignal(false)
  const [typographyOpen, setTypographyOpen] = createSignal(false)
  const [chromeVisible, setChromeVisible] = createSignal(true)
  /** Non-null while scrubbing: the slider shows the user's draft value. */
  const [scrubDraft, setScrubDraft] = createSignal<number | null>(null)
  /** Guards the draft against overlapping jumps: a resolving older jump must
   *  never clear a newer drag's state. */
  let scrubRevision = 0
  const [fullscreen, setFullscreen] = createSignal(false)

  // --- annotations & search (M6) ------------------------------------------
  const [annotations, setAnnotations] = createSignal<Annotation[]>([])
  const [selectionAnchor, setSelectionAnchor] = createSignal<SelectionAnchor | null>(null)
  const [activeAnnotation, setActiveAnnotation] = createSignal<{
    id: string
    x: number
    y: number
  } | null>(null)
  const [bookmarksOpen, setBookmarksOpen] = createSignal(false)
  const [searchOpen, setSearchOpen] = createSignal(false)
  // Search input is local-first: the field re-renders on the same frame;
  // only the results query is async (debounced, generation-guarded).
  const [searchQuery, setSearchQuery] = createSignal('')
  const [searchResults, setSearchResults] = createSignal<SearchResult[]>([])
  const [searching, setSearching] = createSignal(false)
  let searchGeneration = 0
  let searchDebounce: ReturnType<typeof setTimeout> | undefined
  let activeSearch: { cancel: () => void } | undefined

  function cancelActiveSearch(): void {
    clearTimeout(searchDebounce)
    activeSearch?.cancel()
    activeSearch = undefined
  }
  let noteSaveTimer: ReturnType<typeof setTimeout> | undefined
  interface NoteDraft {
    id: string
    value: string
    rev: number
  }
  let noteDraft: NoteDraft | undefined
  let noteRevision = 0
  /** Serializes note persistence so close/unmount can await what a popover
   *  flush already started. */
  let noteInFlight: Promise<void> = Promise.resolve()

  /** Debounced note persistence with an explicit awaitable flush path. */
  function onNoteInput(id: string, value: string): void {
    // Optimistic local update on the same frame.
    applyAnnotations(
      annotations().map((a) => (a.id === id ? { ...a, note: value, updatedAt: Date.now() } : a)),
    )
    noteDraft = { id, value, rev: ++noteRevision }
    clearTimeout(noteSaveTimer)
    noteSaveTimer = setTimeout(() => void flushNote(), 400)
  }

  /**
   * Persists a pending note edit and awaits the ack, serialized behind any
   * in-flight flush. A failure retains the edit ONLY if no newer edit
   * arrived meanwhile (revision check) — newer typing always wins.
   */
  function flushNote(): Promise<void> {
    clearTimeout(noteSaveTimer)
    noteInFlight = noteInFlight.then(() => persistPendingNote())
    return noteInFlight
  }

  /** Reads via an accessor: TS narrows the closure-mutated `noteDraft`
   *  binding incorrectly across awaits (writes happen in other closures). */
  function readNoteDraft(): NoteDraft | undefined {
    return noteDraft
  }

  /**
   * Note edits get the same durability treatment as reading positions: a
   * localStorage outbox entry per annotation, written BEFORE the IPC save
   * and cleared on ack, replayed on next open. Unmount can discard memory;
   * the outbox survives.
   */
  const noteOutboxKey = (annotationId: string) => `liseur:pending-note:${bookId}:${annotationId}`

  async function persistPendingNote(): Promise<void> {
    const pending = readNoteDraft()
    if (!pending) return
    noteDraft = undefined
    // Resolve temp ids FIRST: the durable outbox must be keyed by the real
    // annotation id, or a replay after restart would discard it as orphaned.
    const realId = await resolveAnnotationId(pending.id)
    if (!realId) {
      try {
        localStorage.removeItem(noteOutboxKey(pending.id))
      } catch {
        /* ignore */
      }
      return // create failed and rolled back; the edit is moot
    }
    if (realId !== pending.id) {
      try {
        localStorage.removeItem(noteOutboxKey(pending.id)) // migrate tmp key
      } catch {
        /* ignore */
      }
    }
    try {
      localStorage.setItem(
        noteOutboxKey(realId),
        JSON.stringify({ value: pending.value, at: Date.now() }),
      )
    } catch {
      // storage unavailable: in-memory draft + handshake still apply
    }
    try {
      await window.liseur.annotations.update(realId, { note: pending.value || null })
      try {
        localStorage.removeItem(noteOutboxKey(realId))
      } catch {
        /* ignore */
      }
    } catch (err) {
      console.error('failed to save note', err)
      // The outbox entry stays (durable); also retain the in-memory draft
      // unless a newer edit superseded this one.
      const existing = readNoteDraft()
      if (!existing || existing.rev < pending.rev) noteDraft = pending
    }
  }

  /** Replays durable note outbox entries over the freshly loaded list. */
  async function replayPendingNotes(book: OpenedBook['book']): Promise<void> {
    const prefix = `liseur:pending-note:${book.id}:`
    let keys: string[]
    try {
      keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix))
    } catch {
      return
    }
    for (const key of keys) {
      try {
        const { value, at } = JSON.parse(localStorage.getItem(key) ?? '{}') as {
          value?: string
          at?: number
        }
        const annotationId = key.slice(prefix.length)
        const current = annotations().find((a) => a.id === annotationId)
        if (typeof value !== 'string' || !current || current.updatedAt >= (at ?? 0)) {
          localStorage.removeItem(key) // stale or orphaned
          continue
        }
        applyAnnotations(
          annotations().map((a) => (a.id === annotationId ? { ...a, note: value } : a)),
        )
        await window.liseur.annotations.update(annotationId, { note: value || null })
        localStorage.removeItem(key)
      } catch {
        // leave the entry for next time
      }
    }
  }

  let engine: ReaderEngine | undefined
  let viewport: HTMLElement | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let lastSavedAt = 0
  let disposed = false

  const percent = () => Math.round((position()?.totalProgression ?? 0) * 1000) / 10

  // --- progress persistence (outbox + handshake; see M4 review) ----------

  function scheduleSave(): void {
    clearTimeout(saveTimer)
    if (Date.now() - lastSavedAt > 2000) void saveProgress()
    saveTimer = setTimeout(() => void saveProgress(), PROGRESS_SAVE_DEBOUNCE_MS)
  }

  let saveRevision = 0

  interface PendingProgress {
    rev: number
    locator: Locator
    progression?: number | undefined
    at: number
  }

  const pendingKey = () => `liseur:pending-progress:${bookId}`

  /** Removes the outbox entry only if it still holds THIS save's revision —
   *  an older overlapping ack must never delete a newer pending position. */
  function clearOutbox(rev: number): void {
    try {
      const raw = localStorage.getItem(pendingKey())
      if (!raw) return
      if ((JSON.parse(raw) as Partial<PendingProgress>).rev === rev) {
        localStorage.removeItem(pendingKey())
      }
    } catch {
      // malformed entry: leave it; recovery validates before use
    }
  }

  async function persistPosition(eng: ReaderEngine): Promise<void> {
    const info = eng.pageInfo()
    const locator = eng.locator()
    const progression = info.endOfBook ? 1 : info.totalProgression
    lastSavedAt = Date.now()
    // Outbox: the latest position is synchronously mirrored to localStorage
    // before the async IPC save, so even a hard crash loses nothing. The
    // outbox write is best-effort — storage failures (quota, privacy modes)
    // must never block the database save.
    const rev = ++saveRevision
    try {
      localStorage.setItem(
        pendingKey(),
        JSON.stringify({ rev, locator, progression, at: lastSavedAt }),
      )
    } catch {
      // storage unavailable: the worker save below still runs
    }
    try {
      await window.liseur.reader.setProgress(bookId, locator, progression)
      clearOutbox(rev)
    } catch (err) {
      console.error('failed to save progress', err)
    }
  }

  async function saveProgress(): Promise<void> {
    if (!engine || disposed) return
    await persistPosition(engine)
  }

  function readPending(): PendingProgress | null {
    try {
      const raw = localStorage.getItem(pendingKey())
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<PendingProgress>
      const valid =
        typeof parsed.rev === 'number' &&
        typeof parsed.at === 'number' &&
        !!parsed.locator &&
        typeof parsed.locator.href === 'string' &&
        (parsed.progression === undefined ||
          (typeof parsed.progression === 'number' &&
            Number.isFinite(parsed.progression) &&
            parsed.progression >= 0 &&
            parsed.progression <= 1))
      if (!valid) {
        localStorage.removeItem(pendingKey()) // malformed: never replay junk
        return null
      }
      return parsed as PendingProgress
    } catch {
      return null
    }
  }

  /**
   * A crashed session's outbox entry is newer than anything the DB acked:
   * replay it (locator AND progression, so finished state survives), clear
   * it on ack, and resume from it. Returns the locator to start from.
   */
  async function replayPending(book: OpenedBook['book']): Promise<Locator | null> {
    const pending = readPending()
    if (!pending) return null
    if (pending.at <= (book.progress?.updatedAt ?? 0)) {
      // The DB already holds something at least as new — stale outbox.
      clearOutbox(pending.rev)
      return null
    }
    saveRevision = Math.max(saveRevision, pending.rev)
    try {
      await window.liseur.reader.setProgress(bookId, pending.locator, pending.progression)
      clearOutbox(pending.rev)
    } catch (err) {
      console.error('failed to replay pending progress', err)
    }
    return pending.locator
  }

  // --- chrome auto-hide ("hidden reading mode") ---------------------------

  function showChrome(): void {
    setChromeVisible(true)
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      // Open panels pin the chrome — hiding it from under an open menu is rude.
      const pinned =
        tocOpen() || typographyOpen() || searchOpen() || bookmarksOpen() || activeAnnotation()
      if (!pinned) setChromeVisible(false)
    }, CHROME_HIDE_DELAY_MS)
  }

  /** Closing panels re-arms auto-hide; otherwise chrome could stay pinned forever. */
  function closePopovers(): void {
    const wasOpen =
      tocOpen() ||
      typographyOpen() ||
      searchOpen() ||
      bookmarksOpen() ||
      selectionAnchor() !== null ||
      activeAnnotation() !== null
    setTocOpen(false)
    setTypographyOpen(false)
    if (searchOpen()) cancelActiveSearch() // closing search stops the scan
    setSearchOpen(false)
    setBookmarksOpen(false)
    setSelectionAnchor(null)
    setActiveAnnotation(null)
    void flushNote() // closing a popover never loses an in-flight note edit
    if (wasOpen) showChrome()
  }

  // --- annotations & search actions (M6) -----------------------------------
  // All annotation mutations are OPTIMISTIC (AGENTS.md: never wait for
  // persistence before showing feedback): the UI updates first, the worker
  // reconciles asynchronously, failures roll back and log.

  function applyAnnotations(next: Annotation[]): void {
    setAnnotations(next)
    engine?.setAnnotations(next)
  }

  let tempIdCounter = 0
  /** Temp-id → in-flight create promise: follow-up actions (edit/delete) on
   *  a not-yet-persisted annotation wait for its real id, so a fast
   *  delete-after-create can never strand a row in the database. */
  const pendingCreates = new Map<string, Promise<Annotation>>()

  async function resolveAnnotationId(id: string): Promise<string | null> {
    if (!id.startsWith('tmp-')) return id
    const pending = pendingCreates.get(id)
    if (!pending) return null
    try {
      return (await pending).id
    } catch {
      return null // create already failed and rolled back
    }
  }

  function optimisticCreate(input: {
    kind: 'highlight' | 'bookmark'
    locator: Locator
    color?: HighlightColor
  }): void {
    const now = Date.now()
    const tempId = `tmp-${now}-${tempIdCounter++}`
    const temp: Annotation = {
      id: tempId,
      bookId: bookId,
      kind: input.kind,
      locator: input.locator,
      createdAt: now,
      updatedAt: now,
    }
    if (input.color) temp.color = input.color
    applyAnnotations([...annotations(), temp])

    const createPromise = window.liseur.annotations.create({
      bookId: bookId,
      kind: input.kind,
      locator: input.locator,
      ...(input.color ? { color: input.color } : {}),
    })
    pendingCreates.set(tempId, createPromise)
    createPromise
      .then((saved) => {
        pendingCreates.delete(tempId)
        // Only swap in the real row if the temp one is still there (a queued
        // delete may have legitimately removed it first).
        if (annotations().some((a) => a.id === tempId)) {
          applyAnnotations(annotations().map((a) => (a.id === tempId ? saved : a)))
        }
      })
      .catch((err) => {
        pendingCreates.delete(tempId)
        console.error('failed to create annotation', err)
        applyAnnotations(annotations().filter((a) => a.id !== tempId))
      })
  }

  function createHighlight(color: HighlightColor): void {
    const anchor = selectionAnchor()
    if (!anchor || !engine) return
    setSelectionAnchor(null)
    optimisticCreate({ kind: 'highlight', locator: anchor.locator, color })
  }

  function applyPatch(id: string, patch: { color?: HighlightColor | null; note?: string | null }) {
    applyAnnotations(
      annotations().map((a) => {
        if (a.id !== id) return a
        const next = { ...a, updatedAt: Date.now() }
        if (patch.color !== undefined) next.color = patch.color ?? undefined
        if (patch.note !== undefined) next.note = patch.note ?? undefined
        return next
      }),
    )
  }

  async function updateAnnotation(
    id: string,
    patch: { color?: HighlightColor | null; note?: string | null },
  ): Promise<void> {
    if (!annotations().some((a) => a.id === id)) return
    applyPatch(id, patch) // optimistic, same frame
    // A temp id means the create is still in flight — queue behind it so the
    // worker never sees an id it doesn't know.
    const realId = await resolveAnnotationId(id)
    if (!realId) return // create failed; already rolled back
    // The create reply may have swapped the row to the real id, clobbering
    // the optimistic patch — re-apply under the real id and roll back to the
    // RECONCILED row (never the temp-id one) on failure.
    const reconciled = annotations().find((a) => a.id === realId)
    if (reconciled) applyPatch(realId, patch)
    try {
      const updated = await window.liseur.annotations.update(realId, patch)
      if (updated) {
        applyAnnotations(annotations().map((a) => (a.id === realId ? updated : a)))
      }
    } catch (err) {
      console.error('failed to update annotation', err)
      if (reconciled) {
        applyAnnotations(annotations().map((a) => (a.id === realId ? reconciled : a)))
      }
    }
  }

  async function deleteAnnotation(id: string): Promise<void> {
    setActiveAnnotation(null)
    // Capture the row BEFORE removal — a worker failure must restore it.
    const target = annotations().find((a) => a.id === id)
    if (!target) return
    applyAnnotations(annotations().filter((a) => a.id !== id))
    const realId = await resolveAnnotationId(id)
    if (!realId) return // never persisted (failed temp): nothing to delete
    // After temp→real reconciliation the row may live under its real id; if
    // the swap never re-inserted it (fast delete), restore the real-id row.
    const persisted = annotations().find((a) => a.id === realId) ?? { ...target, id: realId }
    try {
      await window.liseur.annotations.delete(realId)
    } catch (err) {
      console.error('failed to delete annotation', err)
      applyAnnotations([...annotations().filter((a) => a.id !== realId && a.id !== id), persisted])
    }
  }

  /** Page-level bookmark toggle for the current position. */
  async function toggleBookmark(): Promise<void> {
    if (!engine) return
    const locator = engine.locator()
    const pageCount = engine.pageInfo().pageCount
    const existing = annotations().find(
      (a) =>
        a.kind === 'bookmark' &&
        a.locator.href === locator.href &&
        Math.round((a.locator.locations?.progression ?? 0) * pageCount) ===
          Math.round((locator.locations?.progression ?? 0) * pageCount),
    )
    if (existing) {
      await deleteAnnotation(existing.id)
      return
    }
    optimisticCreate({ kind: 'bookmark', locator })
  }

  function pageBookmarked(): boolean {
    const pos = position()
    if (!pos) return false
    return annotations().some(
      (a) =>
        a.kind === 'bookmark' &&
        a.locator.href === engine?.locator().href &&
        Math.round((a.locator.locations?.progression ?? 0) * pos.pageCount) === pos.page,
    )
  }

  function onSearchInput(value: string): void {
    // Same-frame local update; the worker query is debounced separately.
    setSearchQuery(value)
    clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => void runSearch(), 200)
  }

  async function runSearch(): Promise<void> {
    const query = searchQuery().trim()
    const generation = ++searchGeneration
    setSearchResults([])
    // Every query transition cancels the previous scan — including emptying
    // the field or closing the panel (see cancelActiveSearch callers).
    cancelActiveSearch()
    if (!query) {
      setSearching(false)
      return
    }
    setSearching(true)
    try {
      const handle = await window.liseur.reader.search(bookId, query, (batch) => {
        if (generation !== searchGeneration) return // stale search
        setSearchResults((list) => [...list, ...batch])
      })
      if (generation !== searchGeneration) {
        handle.cancel() // superseded while the request was being set up
        return
      }
      activeSearch = handle
      await handle.done
    } catch (err) {
      console.error('book search failed', err)
    }
    if (generation === searchGeneration) {
      setSearching(false)
      activeSearch = undefined
    }
  }

  function jumpToResult(result: SearchResult): void {
    const locator: Locator = {
      href: result.href,
      text: { before: result.before, highlight: result.match, after: result.after },
    }
    cancelActiveSearch() // jumping closes the panel; the scan stops too
    setSearchOpen(false)
    showChrome()
    void engine?.goToLocator(locator)
  }

  // --- preferences (persisted via settings) --------------------------------

  function applyPrefs(patch: Partial<ReaderPreferences>): void {
    const merged = { ...prefs(), ...patch }
    const next = { ...merged, fontSize: clampFontSize(merged.fontSize) }
    setPrefs(next)
    engine?.setPreferences(next)
    // Persist across sessions and books; tiny settings write, fire-and-forget
    // (but log failures — silent preference loss is a bug).
    void window.liseur.settings
      .set({ reader: next })
      .catch((err) => console.error('failed to persist reader preferences', err))
  }

  /** One panel at a time; closing re-arms auto-hide. */
  function togglePopover(which: 'toc' | 'typography' | 'search' | 'bookmarks'): void {
    const opening =
      which === 'toc'
        ? !tocOpen()
        : which === 'typography'
          ? !typographyOpen()
          : which === 'search'
            ? !searchOpen()
            : !bookmarksOpen()
    closePopovers()
    if (opening) {
      if (which === 'toc') setTocOpen(true)
      else if (which === 'typography') setTypographyOpen(true)
      else if (which === 'search') setSearchOpen(true)
      else setBookmarksOpen(true)
      showChrome()
    }
  }

  /** ARIA radio-group keyboard pattern: arrows move selection and focus. */
  function radioGroupKeydown<T extends string | number>(
    e: KeyboardEvent,
    values: readonly T[],
    current: T,
    apply: (value: T) => void,
  ): void {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return
    e.preventDefault()
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
    const next = values[(values.indexOf(current) + delta + values.length) % values.length]!
    apply(next)
    queueMicrotask(() => {
      const group = (e.target as HTMLElement).closest('[role="radiogroup"]')
      group?.querySelector<HTMLElement>(`[data-value="${String(next)}"]`)?.focus()
    })
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen()
  }

  // --- input ---------------------------------------------------------------

  /** Handles keys from the document AND forwarded from inside the book
   *  (iframe key events never cross the boundary). */
  function onKeydown(e: { key: string; preventDefault(): void; target?: unknown }): void {
    // Any key press reveals the chrome (hidden-reading mode is pointer- AND
    // keyboard-dismissable).
    showChrome()

    // Escape is layered and always handled, regardless of focus: panels →
    // fullscreen → back to library. (No "blur the input" layer: Escape is
    // the reader's primary exit and must never be swallowed.)
    //
    // It is handled BEFORE the engine exists, too. A big book takes a moment
    // to open, and opening the wrong one used to trap you there with no way
    // out until it had finished laying itself out.
    if (e.key === 'Escape') {
      e.preventDefault()
      if (
        tocOpen() ||
        typographyOpen() ||
        searchOpen() ||
        bookmarksOpen() ||
        selectionAnchor() !== null ||
        activeAnnotation() !== null
      ) {
        closePopovers()
      } else if (document.fullscreenElement) {
        void document.exitFullscreen()
      } else {
        close()
      }
      return
    }

    if (!engine) return
    const target = (e.target ?? {}) as HTMLElement

    if (target.tagName === 'INPUT' && target.classList.contains('reader-scrubber')) {
      // The focused scrubber owns only navigation keys (they adjust the
      // slider); shortcuts like f/t/c/+/- keep working.
      if (
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) ||
        e.key === ' '
      ) {
        return
      }
    }
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        e.preventDefault()
        void engine.nextPage()
        break
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault()
        void engine.prevPage()
        break
      case '+':
      case '=':
        applyPrefs({ fontSize: clampFontSize(prefs().fontSize + 1) })
        break
      case '-':
        applyPrefs({ fontSize: clampFontSize(prefs().fontSize - 1) })
        break
      case 'c':
        applyPrefs({ columns: prefs().columns === 1 ? 2 : 1 })
        break
      case 'f':
      case 'F11':
        e.preventDefault()
        toggleFullscreen()
        break
    }
  }

  function close(): void {
    clearTimeout(saveTimer)
    cancelActiveSearch()
    const finalEngine = engine
    engine = undefined
    props.onClose() // visual first — never waits on persistence
    // Durable exit: persist the captured final position and any pending note
    // (serialized behind in-flight flushes) before destroying the engine.
    void (async () => {
      try {
        if (finalEngine) await persistPosition(finalEngine)
        await flushNote()
      } finally {
        finalEngine?.destroy()
      }
    })()
  }

  // Key handling at document level: clicks land on iframes/zones and must
  // not swallow page turns. One listener only (registered here, not on the
  // root div — both would fire for the same event).
  document.addEventListener('keydown', onKeydown)
  const onFullscreenChange = () => setFullscreen(!!document.fullscreenElement)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  // Close-time handshake: main holds the window close until the final
  // position is durably in the worker (acked), bounded by a 5 s timeout.
  window.liseur.reader.setActive(true)
  const offFlush = window.liseur.reader.onFlushProgress(async () => {
    clearTimeout(saveTimer)
    // The close handshake awaits BOTH the final position and any pending
    // note edit — neither is lost on window close.
    await Promise.all([saveProgress(), flushNote()])
  })

  onMount(async () => {
    showChrome()
    try {
      // Load persisted reader preferences before first layout.
      const settings = await window.liseur.settings.get()
      if (settings.reader) {
        // A stored size from an older build (or a hand-edited file) must not
        // outlive the current bounds.
        const stored = { ...DEFAULT_READER_PREFERENCES, ...settings.reader }
        setPrefs({ ...stored, fontSize: clampFontSize(stored.fontSize) })
      }

      const result = await window.liseur.reader.open(bookId)
      if (disposed || !viewport) return // closed while opening
      setOpened(result)
      const created: ReaderEngine = new ColumnEngine(
        viewport,
        result.contentBaseUrl,
        result.spine,
        result.toc,
        prefs(),
      )
      created.onPosition((info) => {
        setPosition(info)
        scheduleSave()
      })
      // Annotations: the engine re-anchors them into every loaded chapter.
      setAnnotations(result.annotations)
      created.setAnnotations(result.annotations)
      // Durable note outbox: replay edits that a crash/close never acked.
      await replayPendingNotes(result.book)
      if (disposed) {
        created.destroy()
        return
      }
      created.onSelectionChange(() => {
        if (disposed) return
        setSelectionAnchor(created.captureSelection())
      })
      created.onAnnotationClick((id, x, y) => {
        if (disposed) return
        setSelectionAnchor(null)
        setActiveAnnotation({ id, x, y })
      })
      // Events inside the book iframe never reach the document — the engine
      // forwards them so chrome auto-hide and shortcuts work there too.
      created.onActivity(() => showChrome())
      created.onKeyEvent((e) => onKeydown(e))
      created.onCenterTap(() => {
        if (
          chromeVisible() &&
          !tocOpen() &&
          !typographyOpen() &&
          !searchOpen() &&
          !bookmarksOpen()
        ) {
          setChromeVisible(false)
        } else {
          showChrome()
        }
      })
      // A crashed session's unsaved position (localStorage outbox) is
      // newer than the database's — replay and resume there.
      const start = (await replayPending(result.book)) ?? result.book.progress?.locator ?? null
      if (disposed) {
        created.destroy()
        return
      }
      await created.open(start)
      if (disposed) {
        // Closed while the first layout was in flight.
        created.destroy()
        return
      }
      engine = created
    } catch (err) {
      if (!disposed) setError(err instanceof Error ? err.message : String(err))
    }
  })

  onCleanup(() => {
    disposed = true
    clearTimeout(saveTimer)
    clearTimeout(hideTimer)
    clearTimeout(searchDebounce)
    cancelActiveSearch()
    void flushNote()
    document.removeEventListener('keydown', onKeydown)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    offFlush()
    window.liseur.reader.setActive(false)
    engine?.destroy()
    engine = undefined
  })

  const chromeClass = () => ({ 'chrome-hidden': !chromeVisible() })

  return (
    // Chrome auto-hide listens to pointer movement over the whole reader.
    <div class="reader-screen" tabIndex={-1} onPointerMove={showChrome}>
      <header
        classList={chromeClass()}
        class="reader-topbar"
        aria-hidden={!chromeVisible()}
        inert={!chromeVisible()}
      >
        <button
          type="button"
          class="icon-button"
          onClick={close}
          aria-label="Back to library"
          title="Back to library (Esc)"
        >
          ←
        </button>
        <div class="reader-heading">
          <span class="reader-title">{opened()?.book.title ?? 'Opening…'}</span>
          <span class="reader-author">{opened()?.book.authors.join(', ') ?? ''}</span>
        </div>

        <div class="reader-actions">
          <div class="toc-wrapper">
            <button
              type="button"
              class="icon-button"
              aria-label="Table of contents"
              aria-expanded={tocOpen()}
              onClick={() => togglePopover('toc')}
            >
              ☰
            </button>
            <Show when={tocOpen()}>
              {/* Keys stay local (Escape bubbles up); arrows scroll the list,
                  they must not turn pages. */}
              <div
                class="toc-panel"
                role="navigation"
                aria-label="Table of contents"
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') e.stopPropagation()
                }}
              >
                <TocList
                  entries={flattenToc(opened()?.toc ?? [])}
                  onNavigate={(href) => {
                    closePopovers() // re-arms auto-hide, not just the panel
                    void engine?.goToHref(href)
                  }}
                />
              </div>
            </Show>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="Search in book"
            aria-expanded={searchOpen()}
            title="Search in book"
            onClick={() => togglePopover('search')}
          >
            ⌕
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label={pageBookmarked() ? 'Remove bookmark' : 'Bookmark this page'}
            aria-pressed={pageBookmarked()}
            title="Bookmark this page"
            onClick={() => void toggleBookmark()}
          >
            {pageBookmarked() ? '🔖' : '🏷'}
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Bookmarks and notes"
            aria-expanded={bookmarksOpen()}
            title="Bookmarks and notes"
            onClick={() => togglePopover('bookmarks')}
          >
            ★
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Typography"
            aria-expanded={typographyOpen()}
            title="Typography (size, columns)"
            onClick={() => togglePopover('typography')}
          >
            Aa
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Full screen"
            title="Full screen (F)"
            onClick={toggleFullscreen}
          >
            {fullscreen() ? '⛶ exit' : '⛶'}
          </button>
        </div>
      </header>

      <Show when={typographyOpen()}>
        {/* Keys stay local to the popover (Escape bubbles up for closing);
            otherwise arrows/space would turn pages behind the dialog. */}
        <div
          class="typography-popover"
          role="dialog"
          aria-label="Typography"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation()
          }}
        >
          <div class="typography-row">
            <span class="typography-label">Font size</span>
            <button
              type="button"
              class="icon-button"
              aria-label="Decrease font size"
              disabled={prefs().fontSize <= MIN_FONT_SIZE}
              onClick={() => applyPrefs({ fontSize: clampFontSize(prefs().fontSize - 1) })}
            >
              A−
            </button>
            <span class="typography-value" aria-live="polite" data-font-size={prefs().fontSize}>
              {prefs().fontSize}
            </span>
            <button
              type="button"
              class="icon-button"
              aria-label="Increase font size"
              disabled={prefs().fontSize >= MAX_FONT_SIZE}
              onClick={() => applyPrefs({ fontSize: clampFontSize(prefs().fontSize + 1) })}
            >
              A+
            </button>
          </div>
          <div class="typography-row">
            <span class="typography-label">Columns</span>
            <div
              role="radiogroup"
              aria-label="Columns"
              onKeyDown={(e) =>
                radioGroupKeydown(e, [1, 2], prefs().columns, (columns) =>
                  applyPrefs({ columns: columns as 1 | 2 }),
                )
              }
            >
              {([1, 2] as const).map((n) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={prefs().columns === n}
                  class="columns-choice"
                  classList={{ active: prefs().columns === n }}
                  aria-label={`${n} column${n === 1 ? '' : 's'}`}
                  data-value={n}
                  tabIndex={prefs().columns === n ? 0 : -1}
                  onClick={() => applyPrefs({ columns: n })}
                >
                  {n === 1 ? '❚' : '❚❚'}
                </button>
              ))}
            </div>
          </div>
          <div class="typography-row">
            <span class="typography-label">Margins</span>
            <div
              role="radiogroup"
              aria-label="Margins"
              onKeyDown={(e) =>
                radioGroupKeydown(
                  e,
                  MARGIN_NAMES,
                  marginPresetFor(prefs().measure) ?? 'normal',
                  (name) => applyPrefs({ measure: MARGIN_PRESETS[name as MarginPreset] }),
                )
              }
            >
              {MARGIN_NAMES.map((name) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={marginPresetFor(prefs().measure) === name}
                  class="margin-choice"
                  classList={{ active: marginPresetFor(prefs().measure) === name }}
                  aria-label={`${name} margins`}
                  data-value={name}
                  tabIndex={marginPresetFor(prefs().measure) === name ? 0 : -1}
                  onClick={() => applyPrefs({ measure: MARGIN_PRESETS[name] })}
                >
                  {MARGIN_LABELS[name]}
                </button>
              ))}
            </div>
          </div>
          <div class="typography-row">
            {/* The stepper is the "custom" of narrow/normal/wide: it moves
                the measure off the presets, and none of them stays lit. */}
            <span class="typography-label">Text width</span>
            <button
              type="button"
              class="icon-button"
              aria-label="Decrease text width"
              disabled={prefs().measure <= MIN_MEASURE}
              onClick={() => applyPrefs({ measure: clampMeasure(prefs().measure - 2) })}
            >
              −
            </button>
            <span class="typography-value" aria-live="polite" data-measure={prefs().measure}>
              {prefs().measure}em
            </span>
            <button
              type="button"
              class="icon-button"
              aria-label="Increase text width"
              disabled={prefs().measure >= MAX_MEASURE}
              onClick={() => applyPrefs({ measure: clampMeasure(prefs().measure + 2) })}
            >
              +
            </button>
          </div>
        </div>
      </Show>

      {/* In-book search panel: input local-first, results stream in. */}
      <Show when={searchOpen()}>
        <div
          class="book-search-panel"
          role="dialog"
          aria-label="Search in book"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation()
          }}
        >
          <input
            type="search"
            class="book-search-input"
            placeholder="Search in this book…"
            aria-label="Search in this book"
            value={searchQuery()}
            onInput={(e) => onSearchInput(e.currentTarget.value)}
            ref={(el) => queueMicrotask(() => el.focus())}
          />
          <div class="book-search-status" aria-live="polite">
            <Show when={searching()}>Searching…</Show>
            <Show when={!searching() && searchQuery().trim() && searchResults().length === 0}>
              No matches
            </Show>
            <Show when={searchResults().length > 0}>
              {searchResults().length} match{searchResults().length === 1 ? '' : 'es'}
            </Show>
          </div>
          <ul class="book-search-results">
            {searchResults().map((result) => (
              <li>
                <button
                  type="button"
                  class="book-search-result"
                  onClick={() => jumpToResult(result)}
                >
                  <span class="result-context">{normalizeText(result.before)}</span>
                  <mark>{result.match}</mark>
                  <span class="result-context">{normalizeText(result.after)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Show>

      {/* Bookmarks + notes panel */}
      <Show when={bookmarksOpen()}>
        <div
          class="annotations-panel"
          role="dialog"
          aria-label="Bookmarks and notes"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation()
          }}
        >
          <h2 class="panel-heading">Bookmarks & notes</h2>
          <Show
            when={annotations().length > 0}
            fallback={<p class="panel-empty">No bookmarks or highlights yet.</p>}
          >
            {/* Virtualized like the TOC: annotations have no upper bound. */}
            <AnnotationList
              annotations={annotations()}
              onJump={(locator) => {
                setBookmarksOpen(false)
                void engine?.goToLocator(locator)
              }}
              onDelete={(id) => void deleteAnnotation(id)}
            />
          </Show>
        </div>
      </Show>

      {/* Selection toolbar: appears after selecting text in the book. */}
      <Show when={selectionAnchor()}>
        {(anchor) => (
          <div
            class="selection-toolbar"
            role="toolbar"
            aria-label="Highlight selection"
            style={{ left: `${anchor().x}px`, top: `${anchor().y - 44}px` }}
          >
            {HIGHLIGHT_COLORS.map((color) => (
              <button
                type="button"
                class={`hl-dot hl-${color}`}
                aria-label={`Highlight ${color}`}
                title={color}
                onClick={() => void createHighlight(color)}
              />
            ))}
          </div>
        )}
      </Show>

      {/* Highlight popover: note + color + delete. */}
      <Show when={activeAnnotation()}>
        {(active) => {
          const annotation = () => annotations().find((a) => a.id === active().id)
          return (
            <div
              class="annotation-popover"
              role="dialog"
              aria-label="Edit highlight"
              style={{ left: `${active().x}px`, top: `${active().y + 12}px` }}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') e.stopPropagation()
              }}
            >
              <Show when={annotation()} fallback={<span>Deleted.</span>}>
                {(a) => (
                  <>
                    <div class="annotation-colors">
                      {HIGHLIGHT_COLORS.map((color) => (
                        <button
                          type="button"
                          class={`hl-dot hl-${color}`}
                          classList={{ active: a().color === color }}
                          aria-label={`Color ${color}`}
                          title={color}
                          onClick={() => void updateAnnotation(a().id, { color })}
                        />
                      ))}
                    </div>
                    <textarea
                      class="annotation-note"
                      placeholder="Add a note…"
                      aria-label="Note"
                      value={a().note ?? ''}
                      onInput={(e) => onNoteInput(a().id, e.currentTarget.value)}
                    />
                    <button
                      type="button"
                      class="annotation-delete-button"
                      onClick={() => void deleteAnnotation(a().id)}
                    >
                      Delete highlight
                    </button>
                  </>
                )}
              </Show>
            </div>
          )
        }}
      </Show>

      <Show when={error()}>
        {(message) => (
          <p class="reader-error" role="alert">
            Cannot open this book: {message()}
          </p>
        )}
      </Show>

      {/* No overlay buttons: they would block text selection (M6). Taps are
          handled inside the book — left/right third turns, center toggles
          chrome — see engine.ts. */}
      <main
        class="reader-viewport"
        style={{ 'max-width': `${readerMeasurePx(prefs())}px` }}
        ref={(el) => (viewport = el)}
      />

      <footer
        classList={chromeClass()}
        class="reader-footer"
        aria-hidden={!chromeVisible()}
        inert={!chromeVisible()}
      >
        <div class="reader-progress-track" aria-hidden="true">
          <div class="reader-progress-fill" style={{ width: `${percent()}%` }} />
        </div>
        <div class="reader-footer-row">
          <span class="reader-chapter">
            {position()?.chapterTitle ?? ''}
            <Show when={position() && (position()?.pageCount ?? 0) > 1}>
              {' '}
              · {(position()?.page ?? 0) + 1}/{position()?.pageCount}
            </Show>
          </span>
          <input
            type="range"
            class="reader-scrubber"
            aria-label="Jump to position"
            min={0}
            max={1000}
            // While scrubbing, the slider shows the user's draft; position
            // updates only re-bind after the jump resolves.
            value={scrubDraft() ?? Math.round((position()?.totalProgression ?? 0) * 1000)}
            onPointerDown={() => {
              scrubRevision++ // a new drag invalidates any in-flight jump
              setScrubDraft(Math.round((position()?.totalProgression ?? 0) * 1000))
            }}
            onInput={(e) => {
              if (scrubDraft() !== null) setScrubDraft(Number(e.currentTarget.value))
            }}
            onPointerCancel={() => {
              scrubRevision++
              setScrubDraft(null)
            }}
            onChange={(e) => {
              // Capture the target BEFORE touching state: clearing the draft
              // first would flash the stale position back onto the slider.
              const target = Number(e.currentTarget.value) / 1000
              const rev = ++scrubRevision
              void engine?.goToProgression(target).finally(() => {
                if (rev === scrubRevision) setScrubDraft(null)
              })
            }}
          />
          <span class="reader-percent">{position()?.endOfBook ? 'Finished' : `${percent()}%`}</span>
        </div>
      </footer>
    </div>
  )
}

/**
 * TOC, virtualized like the book grid: the tree is flattened iteratively
 * (untrusted nesting depth can't overflow the stack; flat data is tiny), and
 * only the visible window of rows is ever mounted — every entry stays
 * reachable, no matter how large the TOC.
 */
const TOC_ROW_HEIGHT = 34

interface FlatTocEntry {
  label: string
  href: string
  depth: number
}

function flattenToc(entries: OpenedBook['toc']): FlatTocEntry[] {
  const out: FlatTocEntry[] = []
  const stack = entries.map((e) => ({ entry: e, depth: 0 })).reverse()
  while (stack.length > 0) {
    const { entry, depth } = stack.pop()!
    out.push({ label: entry.label, href: entry.href, depth })
    for (let i = entry.children.length - 1; i >= 0; i--) {
      stack.push({ entry: entry.children[i]!, depth: depth + 1 })
    }
  }
  return out
}

/** Virtualized annotations list (same computeRange pattern as the TOC). */
const ANNOTATION_ROW_HEIGHT = 34

function AnnotationList(props: {
  annotations: Annotation[]
  onJump: (locator: Locator) => void
  onDelete: (id: string) => void
}): JSX.Element {
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportHeight, setViewportHeight] = createSignal(0)
  let scrollEl: HTMLDivElement | undefined
  let raf = 0

  onMount(() => {
    if (!scrollEl) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setViewportHeight(entry.contentRect.height)
    })
    observer.observe(scrollEl)
    onCleanup(() => observer.disconnect())
  })
  onCleanup(() => cancelAnimationFrame(raf))

  const range = () =>
    computeRange(
      props.annotations.length,
      1,
      ANNOTATION_ROW_HEIGHT,
      scrollTop(),
      viewportHeight(),
      5,
    )
  const visible = () => props.annotations.slice(range().start, range().end)

  const onScroll = (e: Event) => {
    const target = e.currentTarget as HTMLDivElement
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => setScrollTop(target.scrollTop))
  }

  return (
    <div
      class="annotations-scroll"
      ref={(el) => (scrollEl = el)}
      onScroll={onScroll}
      style={{ height: `min(${props.annotations.length * ANNOTATION_ROW_HEIGHT + 8}px, 50vh)` }}
    >
      <div style={{ height: `${range().totalHeight}px`, position: 'relative' }}>
        <div style={{ transform: `translateY(${range().offsetTop}px)` }}>
          {visible().map((annotation) => (
            <div class="annotations-item" style={{ height: `${ANNOTATION_ROW_HEIGHT}px` }}>
              <button
                type="button"
                class="annotation-jump"
                onClick={() => props.onJump(annotation.locator)}
              >
                <Show when={annotation.kind === 'highlight'}>
                  <span class={`hl-dot hl-${annotation.color ?? 'yellow'}`} aria-hidden="true" />
                </Show>
                {annotation.kind === 'bookmark' ? '🔖 ' : ''}
                {annotation.kind === 'highlight'
                  ? normalizeText(annotation.locator.text?.highlight ?? '').slice(0, 80)
                  : (annotation.locator.title ?? 'Bookmark')}
                <Show when={annotation.note}>
                  <span class="annotation-note-preview"> — {annotation.note}</span>
                </Show>
              </button>
              <button
                type="button"
                class="icon-button annotation-delete"
                aria-label="Delete"
                onClick={() => props.onDelete(annotation.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TocList(props: {
  entries: FlatTocEntry[]
  onNavigate: (href: string) => void
}): JSX.Element {
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportHeight, setViewportHeight] = createSignal(0)
  let scrollEl: HTMLDivElement | undefined
  let raf = 0

  onMount(() => {
    if (!scrollEl) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setViewportHeight(entry.contentRect.height)
    })
    observer.observe(scrollEl)
    onCleanup(() => observer.disconnect())
  })
  onCleanup(() => cancelAnimationFrame(raf))

  const range = () =>
    computeRange(props.entries.length, 1, TOC_ROW_HEIGHT, scrollTop(), viewportHeight(), 5)
  const visible = () => props.entries.slice(range().start, range().end)

  const onScroll = (e: Event) => {
    const target = e.currentTarget as HTMLDivElement
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => setScrollTop(target.scrollTop))
  }

  return (
    <div
      class="toc-scroll"
      ref={(el) => (scrollEl = el)}
      onScroll={onScroll}
      style={{ height: `min(${props.entries.length * TOC_ROW_HEIGHT + 16}px, 60vh)` }}
    >
      <div style={{ height: `${range().totalHeight}px`, position: 'relative' }}>
        <div style={{ transform: `translateY(${range().offsetTop}px)` }}>
          {visible().map((entry) => (
            <button
              type="button"
              class="toc-entry"
              style={{
                'padding-left': `${8 + entry.depth * 16}px`,
                height: `${TOC_ROW_HEIGHT}px`,
              }}
              onClick={() => props.onNavigate(entry.href)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
