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
  /** Identifier used to derive/lookup the cover; placeholder covers in M1. */
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

export interface Settings {
  theme: AppTheme
}
