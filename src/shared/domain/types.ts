/**
 * Core domain types shared between renderer, worker, and main.
 *
 * Locator semantics intentionally follow Readium Web locators so that a
 * future reader engine (Milestone 4) and the Android app's sync data stay
 * compatible.
 */

export type BookId = string

export interface Locator {
  href: string
  type?: string
  title?: string
  locations?: {
    progression?: number
    totalProgression?: number
    position?: number
    /** CSS selector of the anchoring element (highlights; M6). */
    cssSelector?: string
  }
  text?: {
    before?: string
    highlight?: string
    after?: string
  }
}

export interface ReadingProgress {
  locator: Locator
  /** 0..1 progression across the whole publication. */
  progression?: number
  updatedAt: number
}

export interface Book {
  id: BookId
  title: string
  authors: string[]
  localPath?: string
  remoteId?: string
  /** Which configured server this book came from (M7). */
  serverId?: string
  /** Cover thumbnail to look up; books without one get a generated cover. */
  coverId?: string
  finished: boolean
  archived: boolean
  downloaded: boolean
  addedAt: number
  lastOpenedAt?: number
  progress?: ReadingProgress
}

export type LibraryFilter = 'all' | 'downloaded' | 'unread' | 'archived'

export type LibrarySortKey = 'recent' | 'title' | 'author' | 'added'

export type SortDirection = 'asc' | 'desc'

export interface LibraryQuery {
  filter: LibraryFilter
  sort: LibrarySortKey
  direction: SortDirection
  search: string
}

export interface LibraryQueryResult {
  books: Book[]
  totalCount: number
  /** Echo of the request id so the renderer can discard stale results. */
  requestId: number
}

export type AppTheme = 'system' | 'light' | 'dark'

/**
 * The reader page is always white on black ink — a book is paper. There is
 * deliberately no reader theme picker: colour schemes belong to the app
 * chrome, not to the text.
 */
export interface ReaderPreferences {
  fontSize: number
  columns: 1 | 2
}

export interface Settings {
  theme: AppTheme
  /** Reader preferences persist across sessions and books (M5). */
  reader?: ReaderPreferences | undefined
}

/** One item of the reading order (a chapter document in the EPUB). */
export interface SpineItem {
  /** Archive path of the item, resolved against the OPF directory. */
  href: string
  mediaType: string
  /** False for non-linear items (endnotes etc.); still navigable via TOC. */
  linear: boolean
}

export interface TocEntry {
  label: string
  /** Archive path, optionally with #fragment. */
  href: string
  children: TocEntry[]
}

/** Returned when the reader opens a book: everything needed to render. */
export interface OpenedBook {
  book: Book
  spine: SpineItem[]
  toc: TocEntry[]
  /** Base URL (liseur-epub scheme) the renderer builds resource URLs from. */
  contentBaseUrl: string
  /** Existing annotations (highlights + bookmarks) for this book. */
  annotations: Annotation[]
}

export type AnnotationKind = 'highlight' | 'bookmark'

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]

export interface Annotation {
  id: string
  bookId: string
  kind: AnnotationKind
  color?: HighlightColor | undefined
  note?: string | undefined
  /**
   * Readium-compatible locator. For highlights, `text.before/highlight/after`
   * plus a CSS selector in `locations.cssSelector` make the anchor survive
   * typography changes (re-anchored from text, never geometry).
   */
  locator: Locator
  createdAt: number
  updatedAt: number
}

/** One in-book search hit, streamable from the worker. */
export interface SearchResult {
  /** Spine item archive path. */
  href: string
  /** Text context for re-anchoring and display. */
  before: string
  match: string
  after: string
}

export interface SearchBatch {
  results: SearchResult[]
  /** True when the whole book has been searched. */
  done: boolean
}
