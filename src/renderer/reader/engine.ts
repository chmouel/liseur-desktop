import type {
  Annotation,
  Locator,
  ReaderPreferences,
  SpineItem,
  TocEntry,
} from '../../shared/domain/types'
import {
  clampPage,
  pageCountFor,
  pageForProgression,
  progressionInItem,
  targetForProgression,
  totalProgression,
} from './pagination'
import { injectReaderAssets, itemDirOf } from './reader-theme'
import { buildTextStream, locatorForRange, rangeForLocator } from './anchoring'

/**
 * ReaderEngine — the seam the M4 ADR pins down. The rest of the app only
 * knows this interface; the implementation (today: in-house CSS-multicol
 * engine; the evaluated alternative: Readium Web) can be swapped without
 * touching reader UI or progress persistence.
 */

export interface PageInfo {
  spineIndex: number
  page: number
  pageCount: number
  /** 0..1 across the whole book (lazy per-item estimates; see pagination). */
  totalProgression: number
  chapterTitle?: string | undefined
  /** True when the reader tried to turn past the final page. */
  endOfBook: boolean
}

/** Where a selection anchor was captured (viewport coordinates). */
export interface SelectionAnchor {
  locator: Locator
  x: number
  y: number
}

export interface ReaderEngine {
  open(start: Locator | null): Promise<void>
  nextPage(): Promise<void>
  prevPage(): Promise<void>
  goToHref(href: string): Promise<void>
  /** Scrubber jump: 0..1 across the whole book. */
  goToProgression(fraction: number): Promise<void>
  /** Navigate to a stored locator, re-anchoring by text quote (M6). */
  goToLocator(locator: Locator): Promise<void>
  setPreferences(prefs: ReaderPreferences): void
  preferences(): ReaderPreferences
  locator(): Locator
  pageInfo(): PageInfo
  onPosition(listener: (info: PageInfo) => void): void
  /** The book's annotations; re-anchored into the chapter on every load. */
  setAnnotations(annotations: Annotation[]): void
  /** Current iframe selection as a storable anchor, or null. */
  captureSelection(): SelectionAnchor | null
  /** Hit-test for clicks on highlighted text (annotation id or null). */
  annotationIdAtPoint(x: number, y: number): string | null
  /** Fired when the user (de)selects text inside the book. */
  onSelectionChange(listener: () => void): void
  /** Fired when the user clicks on a rendered highlight (viewport coords). */
  onAnnotationClick(listener: (annotationId: string, x: number, y: number) => void): void
  /**
   * Pointer/keyboard activity inside the book (throttled). Events inside the
   * iframe never reach the parent document — the shell needs these for
   * chrome auto-hide and shortcuts.
   */
  onActivity(listener: () => void): void
  /** Key presses inside the book, forwarded for shell shortcuts. */
  onKeyEvent(listener: (event: { key: string; preventDefault(): void }) => void): void
  /** Tap on the middle third of the page (no text selection, no link). */
  onCenterTap(listener: () => void): void
  destroy(): void
}

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  fontSize: 18,
  theme: 'light',
  columns: 1,
}

/**
 * In-house engine: one sandboxed iframe per book, chapters injected as
 * `srcdoc` with a <base> pointing at the `liseur-epub:` scheme so images,
 * stylesheets and fonts resolve without URL rewriting. Pagination is pure
 * CSS multi-columns + transform — page turns never touch layout, network or
 * persistence.
 */
export class ColumnEngine implements ReaderEngine {
  private readonly iframe: HTMLIFrameElement
  private prefs: ReaderPreferences
  private spineIndex = 0
  private page = 0
  private pageCount = 1
  private readonly pageCounts: (number | null)[]
  private readonly listeners = new Set<(info: PageInfo) => void>()
  private endOfBook = false
  private loadChain: Promise<void> = Promise.resolve()
  private resizeObserver: ResizeObserver | undefined
  private destroyed = false
  private annotations: Annotation[] = []
  /** Live ranges for the current chapter, by annotation id. */
  private readonly highlightRanges = new Map<string, Range>()
  private flashRange: Range | null = null
  private readonly selectionListeners = new Set<() => void>()
  private readonly annotationClickListeners = new Set<(id: string, x: number, y: number) => void>()
  private readonly activityListeners = new Set<() => void>()
  private readonly keyListeners = new Set<
    (event: { key: string; preventDefault(): void }) => void
  >()
  private readonly centerTapListeners = new Set<() => void>()
  private lastActivityAt = 0

  constructor(
    private readonly container: HTMLElement,
    private readonly baseUrl: string,
    private readonly spine: SpineItem[],
    private readonly toc: TocEntry[],
    initial: ReaderPreferences,
  ) {
    this.prefs = { ...initial }
    // Non-linear items count as 0 pages: linear page turning never visits
    // them, so they must not weigh on total progression estimates.
    this.pageCounts = spine.map((s) => (s.linear ? null : 0))

    this.iframe = document.createElement('iframe')
    this.iframe.className = 'reader-iframe'
    // allow-same-origin lets the engine lay out and measure the document;
    // scripts stay disabled (no allow-scripts) and the liseur-epub scheme
    // adds a script-src 'none' CSP on top. srcdoc keeps it off the network.
    this.iframe.sandbox.add('allow-same-origin')
    this.iframe.setAttribute('aria-label', 'Book content')
    container.appendChild(this.iframe)

    this.resizeObserver = new ResizeObserver(() => {
      if (this.destroyed) return
      // Re-layout preserving reading position (progression survives
      // typography/viewport changes — that is what makes locators stable).
      this.relayout()
    })
    this.resizeObserver.observe(container)
  }

  async open(start: Locator | null): Promise<void> {
    const index = start ? this.spine.findIndex((s) => s.href === start.href) : -1
    const target = index >= 0 ? index : this.spine.findIndex((s) => s.linear)
    const progression = index >= 0 ? (start?.locations?.progression ?? 0) : 0
    await this.loadItem(Math.max(0, target), (count) => pageForProgression(progression, count))
  }

  async nextPage(): Promise<void> {
    await this.enqueue(async () => {
      this.endOfBook = false
      if (this.page + 1 < this.pageCount) {
        this.page++
      } else {
        const next = this.nextLinearIndex(1)
        if (next === -1) {
          this.endOfBook = true
          this.emit()
          return
        }
        await this.loadItemLocked(next, 0)
        return
      }
      this.apply()
      this.emit()
    })
  }

  async prevPage(): Promise<void> {
    await this.enqueue(async () => {
      this.endOfBook = false
      if (this.page > 0) {
        this.page--
      } else {
        const prev = this.nextLinearIndex(-1)
        if (prev === -1) return
        await this.loadItemLocked(prev, (count) => count - 1)
        return
      }
      this.apply()
      this.emit()
    })
  }

  async goToHref(href: string): Promise<void> {
    const [path, fragment] = splitFragment(href)
    const index = this.spine.findIndex((s) => s.href === path)
    if (index === -1) return
    await this.enqueue(async () => {
      this.endOfBook = false
      if (index === this.spineIndex && this.iframe.contentDocument) {
        if (fragment) this.page = this.pageForFragment(fragment)
        this.apply()
        this.emit()
        return
      }
      await this.loadItemLocked(index, () => (fragment ? this.pageForFragment(fragment) : 0))
    })
  }

  async goToProgression(fraction: number): Promise<void> {
    const target = targetForProgression(this.pageCounts, fraction)
    await this.enqueue(async () => {
      this.endOfBook = false
      if (target.spineIndex === this.spineIndex) {
        this.page = pageForProgression(target.itemProgression, this.pageCount)
        this.apply()
        this.emit()
        return
      }
      await this.loadItemLocked(target.spineIndex, (count) =>
        pageForProgression(target.itemProgression, count),
      )
    })
  }

  setPreferences(prefs: ReaderPreferences): void {
    this.prefs = { ...prefs }
    this.relayout()
  }

  preferences(): ReaderPreferences {
    return { ...this.prefs }
  }

  locator(): Locator {
    const item = this.spine[this.spineIndex]
    // No `position`: Readium positions are publication-wide and generated,
    // not a spine index — omit until a real positions list exists (M7 sync
    // only needs href + progressions, which are Readium-compatible).
    const locator: Locator = {
      href: item?.href ?? '',
      locations: {
        progression: progressionInItem(this.page, this.pageCount),
        totalProgression: this.pageInfo().totalProgression,
      },
    }
    if (item?.mediaType) locator.type = item.mediaType
    const title = this.chapterTitle()
    if (title) locator.title = title
    return locator
  }

  pageInfo(): PageInfo {
    return {
      spineIndex: this.spineIndex,
      page: this.page,
      pageCount: this.pageCount,
      totalProgression: totalProgression(this.pageCounts, this.spineIndex, this.page),
      chapterTitle: this.chapterTitle(),
      endOfBook: this.endOfBook,
    }
  }

  onPosition(listener: (info: PageInfo) => void): void {
    this.listeners.add(listener)
  }

  // --- annotations (M6) ---------------------------------------------------

  setAnnotations(annotations: Annotation[]): void {
    this.annotations = annotations
    this.renderAnnotations()
  }

  /**
   * The current iframe selection as a storable anchor (CSS selector + text
   * quote) plus viewport coordinates for the floating toolbar.
   */
  captureSelection(): SelectionAnchor | null {
    const doc = this.doc()
    const selection = doc?.getSelection()
    const item = this.spine[this.spineIndex]
    if (!doc?.body || !selection || selection.isCollapsed || selection.rangeCount === 0 || !item) {
      return null
    }
    const range = selection.getRangeAt(0)
    const stream = buildTextStream(doc.body)
    const locator = locatorForRange(
      item.href,
      item.mediaType,
      range,
      stream,
      progressionInItem(this.page, this.pageCount),
    )
    if (!locator) return null
    const rect = range.getBoundingClientRect()
    const frame = this.iframe.getBoundingClientRect()
    return { locator, x: frame.left + rect.left + rect.width / 2, y: frame.top + rect.top }
  }

  /** Hit-test: is viewport point (x, y) inside a rendered highlight? */
  annotationIdAtPoint(x: number, y: number): string | null {
    const doc = this.doc()
    if (!doc) return null
    const point = doc.caretRangeFromPoint(x, y)
    if (!point) return null
    for (const [id, range] of this.highlightRanges) {
      try {
        if (range.comparePoint(point.startContainer, point.startOffset) === 0) return id
      } catch {
        // point outside the range's root: not a hit
      }
    }
    return null
  }

  onSelectionChange(listener: () => void): void {
    this.selectionListeners.add(listener)
  }

  onAnnotationClick(listener: (annotationId: string, x: number, y: number) => void): void {
    this.annotationClickListeners.add(listener)
  }

  onActivity(listener: () => void): void {
    this.activityListeners.add(listener)
  }

  onKeyEvent(listener: (event: { key: string; preventDefault(): void }) => void): void {
    this.keyListeners.add(listener)
  }

  onCenterTap(listener: () => void): void {
    this.centerTapListeners.add(listener)
  }

  /**
   * Navigates to a stored locator: chapter by href, then re-anchor by text
   * quote (survives typography changes) with a brief flash, falling back to
   * the stored progression when the quote can't be found.
   */
  async goToLocator(locator: Locator): Promise<void> {
    const [path] = splitFragment(locator.href)
    const index = this.spine.findIndex((s) => s.href === path)
    if (index === -1) return
    await this.enqueue(async () => {
      this.endOfBook = false
      if (index !== this.spineIndex) {
        await this.loadItemLocked(index, 0)
      }
      let page = pageForProgression(locator.locations?.progression ?? 0, this.pageCount)
      const doc = this.doc()
      if (doc && locator.text?.highlight) {
        const range = rangeForLocator(doc, locator)
        if (range) {
          const rect = range.getBoundingClientRect()
          // Body is at translate(0) right after a load; include the current
          // page offset when we stayed in the same chapter.
          const absX = rect.left + this.page * this.iframe.clientWidth
          page = clampPage(Math.floor(absX / Math.max(1, this.iframe.clientWidth)), this.pageCount)
          this.flashRange = range
        }
      }
      this.page = page
      this.apply()
      this.renderAnnotations()
      this.emit()
      // The flash is ephemeral: clear after a moment without touching layout.
      setTimeout(() => {
        if (this.flashRange && !this.destroyed) {
          this.flashRange = null
          this.renderAnnotations()
        }
      }, 1600)
    })
  }

  /**
   * Re-anchors all highlights into the freshly loaded chapter using the CSS
   * Custom Highlight API — zero DOM mutation, zero layout impact. The
   * registry is per-Window: it must be the IFRAME's, where the ranges and
   * the ::highlight rules live.
   */
  private highlightRegistry: HighlightRegistry | undefined

  private renderAnnotations(): void {
    const doc = this.doc()
    const registry = doc?.defaultView?.CSS.highlights
    this.highlightRegistry = registry
    if (!doc?.body || !registry) return

    this.highlightRanges.clear()
    const byColor = new Map<string, Range[]>()
    const currentHref = this.spine[this.spineIndex]?.href
    for (const annotation of this.annotations) {
      if (annotation.kind !== 'highlight') continue
      if (splitFragment(annotation.locator.href)[0] !== currentHref) continue
      const range = rangeForLocator(doc, annotation.locator)
      if (!range) continue
      this.highlightRanges.set(annotation.id, range)
      const color = annotation.color ?? 'yellow'
      const list = byColor.get(color) ?? []
      list.push(range)
      byColor.set(color, list)
    }
    for (const color of ['yellow', 'green', 'blue', 'pink']) {
      const ranges = byColor.get(color) ?? []
      registry.set(`liseur-hl-${color}`, new Highlight(...ranges))
    }
    if (this.flashRange) registry.set('liseur-flash', new Highlight(this.flashRange))
    else registry.delete('liseur-flash')
  }

  destroy(): void {
    this.destroyed = true
    this.resizeObserver?.disconnect()
    this.iframe.remove()
    this.listeners.clear()
    this.selectionListeners.clear()
    this.annotationClickListeners.clear()
    this.activityListeners.clear()
    this.keyListeners.clear()
    this.centerTapListeners.clear()
    this.highlightRanges.clear()
    this.flashRange = null
    // Clean the iframe's registry (kept by reference — the document is gone).
    for (const color of ['yellow', 'green', 'blue', 'pink']) {
      this.highlightRegistry?.delete(`liseur-hl-${color}`)
    }
    this.highlightRegistry?.delete('liseur-flash')
    this.highlightRegistry = undefined
  }

  // --- internals -------------------------------------------------------

  private nextLinearIndex(direction: 1 | -1): number {
    for (let i = this.spineIndex + direction; i >= 0 && i < this.spine.length; i += direction) {
      if (this.spine[i]?.linear) return i
    }
    return -1
  }

  /** Serializes item loads so fast key repeats can't interleave fetches. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.loadChain = this.loadChain.then(work, work)
    return this.loadChain
  }

  private async loadItem(
    index: number,
    page: number | ((pageCount: number) => number),
  ): Promise<void> {
    await this.enqueue(() => this.loadItemLocked(index, page))
  }

  private async loadItemLocked(
    index: number,
    page: number | ((pageCount: number) => number),
  ): Promise<void> {
    const item = this.spine[index]
    if (!item) return

    const response = await fetch(`${this.baseUrl}${encodeURI(item.href)}`)
    if (!response.ok) throw new Error(`failed to load chapter: ${item.href}`)
    const markup = await response.text()

    this.spineIndex = index
    this.page = 0
    this.pageCount = 1

    await this.renderMarkup(markup, item.href)
    this.pageCount = this.measure()
    this.page = clampPage(typeof page === 'function' ? page(this.pageCount) : page, this.pageCount)
    this.apply()
    this.renderAnnotations()
    this.emit()

    // Late web-font settling can change scrollWidth after the first layout.
    // Re-measure once fonts are ready, preserving the reading position.
    const doc = this.doc()
    const settledIndex = index
    void doc?.fonts?.ready.then(() => {
      if (!this.destroyed && this.spineIndex === settledIndex) this.relayout()
    })
  }

  /**
   * Parses the chapter, installs our <base> (book resources resolve onto
   * the liseur-epub scheme) and a lockdown CSP (no scripts, frames, forms,
   * connections), then srcdoc-loads the serialized document. DOMParser
   * always produces html/head/body — no regex injection to bypass.
   */
  private renderMarkup(markup: string, itemHref: string): Promise<void> {
    const parsed = new DOMParser().parseFromString(markup, 'text/html')

    const base = parsed.createElement('base')
    base.setAttribute('href', `${this.baseUrl}${itemDirOf(itemHref)}/`)
    parsed.head.prepend(base)

    const csp = parsed.createElement('meta')
    csp.setAttribute('http-equiv', 'Content-Security-Policy')
    csp.setAttribute(
      'content',
      "default-src 'none'; img-src liseur-epub: data:; " +
        "style-src 'unsafe-inline' liseur-epub:; font-src liseur-epub:; " +
        "media-src liseur-epub:; connect-src 'none'; frame-src 'none'; form-action 'none'",
    )
    parsed.head.prepend(csp)

    const style = parsed.createElement('style')
    style.id = 'liseur-reader-css'
    parsed.head.appendChild(style)

    const prepared = `<!doctype html>${parsed.documentElement.outerHTML}`
    return new Promise((resolve) => {
      const onLoad = () => {
        this.iframe.removeEventListener('load', onLoad)
        // Fonts/images may settle after load; one rAF is enough in practice
        // and keeps chapter transitions snappy.
        requestAnimationFrame(() => resolve())
      }
      this.iframe.addEventListener('load', onLoad)
      this.iframe.srcdoc = prepared
    })
  }

  private doc(): Document | null {
    return this.iframe.contentDocument
  }

  /** Applies the reader stylesheet and returns the measured page count. */
  private measure(): number {
    const doc = this.doc()
    if (!doc?.body) return 1
    const item = this.spine[this.spineIndex]
    injectReaderAssets(
      doc,
      this.baseUrl,
      item ? itemDirOf(item.href) : '',
      this.prefs,
      this.iframe.clientWidth,
    )
    // Reading scrollWidth forces the reflow we just scheduled.
    const count = pageCountFor(doc.body.scrollWidth, Math.max(1, this.iframe.clientWidth))
    // Only linear items feed total-progression estimates (see pagination.ts).
    if (this.spine[this.spineIndex]?.linear) this.pageCounts[this.spineIndex] = count
    // In-book interaction model (M6): no overlay buttons (they would block
    // text selection). A click is: highlight → popover; link → navigation;
    // text selection in progress → ignore; otherwise a tap on the left/right
    // third turns the page, center tap toggles chrome. Events inside the
    // iframe never reach the parent document, so pointer/keyboard activity
    // is forwarded to the shell via listeners.
    if (!doc.getElementById('liseur-click-guard')) {
      doc.addEventListener('click', (event) => {
        const hit = this.annotationIdAtPoint(event.clientX, event.clientY)
        if (hit) {
          const frame = this.iframe.getBoundingClientRect()
          for (const listener of this.annotationClickListeners) {
            listener(hit, frame.left + event.clientX, frame.top + event.clientY)
          }
          return
        }
        const anchor = (event.target as HTMLElement).closest?.('a[href]')
        if (anchor) {
          event.preventDefault()
          const href = resolveAgainst(anchor.getAttribute('href') ?? '', item?.href ?? '')
          if (href) void this.goToHref(href)
          return
        }
        // A click finishing a text selection must not turn the page.
        const selection = doc.getSelection()
        if (selection && !selection.isCollapsed) return
        const third = event.clientX / Math.max(1, this.iframe.clientWidth)
        if (third < 1 / 3) void this.prevPage()
        else if (third > 2 / 3) void this.nextPage()
        else for (const listener of this.centerTapListeners) listener()
      })
      const notifySelection = () => {
        for (const listener of this.selectionListeners) listener()
      }
      doc.addEventListener('mouseup', notifySelection)
      doc.addEventListener('keyup', notifySelection)
      doc.addEventListener('keydown', (event) => {
        for (const listener of this.keyListeners) listener(event)
      })
      doc.addEventListener('pointermove', () => {
        // High-frequency: report at most a few times per second.
        const now = Date.now()
        if (now - this.lastActivityAt < 300) return
        this.lastActivityAt = now
        for (const listener of this.activityListeners) listener()
      })
      const marker = doc.createElement('meta')
      marker.id = 'liseur-click-guard'
      doc.head?.appendChild(marker)
    }
    return count
  }

  /** Re-lays out the current item keeping the reading position. */
  private relayout(): void {
    void this.enqueue(async () => {
      const doc = this.doc()
      if (!doc?.body) return
      const progression = progressionInItem(this.page, this.pageCount)
      this.pageCount = this.measure()
      this.page = pageForProgression(progression, this.pageCount)
      this.apply()
      this.emit()
    })
  }

  /** The only place the transform changes: page turns are one style write. */
  private apply(): void {
    const body = this.doc()?.body
    if (!body) return
    body.style.transform = `translateX(${-this.page * this.iframe.clientWidth}px)`
  }

  private pageForFragment(fragment: string): number {
    const doc = this.doc()
    const el = fragment ? doc?.getElementById(fragment) : null
    if (!doc || !el) return 0
    // getBoundingClientRect is viewport-relative; the body is at translate 0
    // right after a load, and at -page*width otherwise — normalize both.
    const currentOffset = this.page * this.iframe.clientWidth
    const absX = el.getBoundingClientRect().left + currentOffset
    return clampPage(Math.floor(absX / Math.max(1, this.iframe.clientWidth)), this.pageCount)
  }

  private chapterTitle(): string | undefined {
    const href = this.spine[this.spineIndex]?.href
    if (!href) return undefined
    const flat = flattenToc(this.toc)
    return flat.find((e) => splitFragment(e.href)[0] === href)?.label
  }

  private emit(): void {
    const info = this.pageInfo()
    for (const listener of this.listeners) listener(info)
  }
}

export function flattenToc(toc: readonly TocEntry[]): TocEntry[] {
  const out: TocEntry[] = []
  const walk = (entries: readonly TocEntry[]) => {
    for (const entry of entries) {
      out.push(entry)
      walk(entry.children)
    }
  }
  walk(toc)
  return out
}

function splitFragment(href: string): [string, string] {
  const hash = href.indexOf('#')
  return hash === -1 ? [href, ''] : [href.slice(0, hash), href.slice(hash + 1)]
}

/** Resolves an in-book link against the current item's href. */
function resolveAgainst(href: string, currentHref: string): string {
  if (!href || href.startsWith('liseur-epub:')) return ''
  const [path, fragment] = splitFragment(href)
  if (!path) return `${currentHref}#${fragment}`
  const dir = itemDirOf(currentHref)
  const parts = `${dir ? `${dir}/` : ''}${decodeURIComponent(path)}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${out.join('/')}${fragment ? `#${fragment}` : ''}`
}
