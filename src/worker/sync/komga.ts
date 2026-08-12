import type { Locator } from '../../shared/domain/types'
import { Http } from './http'
import type {
  ProgressRecord,
  PullResult,
  RemoteBook,
  RemoteCatalog,
  RemoteServer,
  TestResult,
} from './types'

/**
 * Komga catalog + progress sync (API key auth, X-API-Key header).
 * Endpoint shapes mirror the Android client (data/komga/*): catalog listing
 * via POST /api/v1/books/list (EPUB+READY filter), progression via
 * GET/PUT /api/v1/books/{id}/progression, positions fallback on 400.
 */

const PAGE_SIZE = 200
const MAX_PAGES = 200

interface KomgaBookDto {
  id: string
  name?: string
  sizeBytes?: number
  lastModified?: string
  media?: { pagesCount?: number }
  metadata?: { title?: string; authors?: { name: string; role?: string }[] }
  readProgress?: { page?: number; completed?: boolean; readDate?: string; deviceId?: string }
}

interface KomgaPageDto {
  content: KomgaBookDto[]
  last?: boolean
}

function parseBook(dto: KomgaBookDto): RemoteBook {
  const writers = dto.metadata?.authors?.filter((a) => !a.role || a.role === 'writer') ?? []
  const authors = (writers.length > 0 ? writers : (dto.metadata?.authors ?? []))
    .map((a) => a.name)
    .filter(Boolean)
  const pages = dto.media?.pagesCount
  let progress: RemoteBook['progress']
  if (dto.readProgress && pages && dto.readProgress.page !== undefined) {
    progress = {
      progression: dto.readProgress.completed
        ? 1
        : pages > 1
          ? dto.readProgress.page / (pages - 1)
          : 0,
      completed: dto.readProgress.completed ?? false,
      updatedAt: dto.readProgress.readDate ? Date.parse(dto.readProgress.readDate) : undefined,
    }
  }
  return {
    remoteId: dto.id,
    title: dto.metadata?.title ?? dto.name ?? dto.id,
    authors,
    sizeBytes: dto.sizeBytes,
    downloadUrl: `/api/v1/books/${dto.id}/file`,
    coverUrl: `/api/v1/books/${dto.id}/thumbnail`,
    progress,
  }
}

/**
 * The search body Komga expects.
 *
 * Every leaf of the condition tree is an operator object: a bare
 * `{ mediaProfile: 'EPUB' }` is rejected with HTTP 400, which is subtle
 * enough that it looked like a server with no books on it. Full text
 * search sits beside the condition, not inside it.
 */
function listBody(query?: string): Record<string, unknown> {
  const condition = {
    allOf: [
      { mediaProfile: { operator: 'is', value: 'EPUB' } },
      { mediaStatus: { operator: 'is', value: 'READY' } },
    ],
  }
  return query ? { condition, fullTextSearch: query } : { condition }
}

export class KomgaCatalog implements RemoteCatalog {
  private readonly http: Http

  /** Komga puts readProgress on every book in a listing page. */
  readonly listsProgress = true

  constructor(
    readonly server: RemoteServer,
    authHeaders: Record<string, string>,
    fetchImpl?: ConstructorParameters<typeof Http>[2],
  ) {
    this.http = new Http(server.url, authHeaders, fetchImpl)
  }

  async testConnection(): Promise<TestResult> {
    const res = await this.http.getJson<{ roles?: string[] }>('/api/v2/users/me')
    if (res.status === 401 || res.status === 403) return { ok: false, detail: 'invalid API key' }
    if (!res.ok) return { ok: false, detail: res.error ?? `HTTP ${res.status}` }
    if (!Array.isArray(res.value?.roles)) {
      return { ok: false, detail: 'not a Komga server' }
    }
    return { ok: true }
  }

  async *listBooks(query?: string): AsyncIterable<RemoteBook[]> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.http.request(
        'POST',
        `/api/v1/books/list?page=${page}&size=${PAGE_SIZE}&sort=metadata.titleSort,asc`,
        {
          body: JSON.stringify(listBody(query)),
          headers: { 'content-type': 'application/json' },
        },
      )
      // A rejected page must not read as "the server has no books": that
      // silence is what made a connected server show an empty library.
      if (!res.ok || !res.value) {
        throw new Error(res.error ?? `catalog listing failed: HTTP ${res.status}`)
      }
      const data = await res.value.json<KomgaPageDto>()
      if (!Array.isArray(data.content) || data.content.length === 0) return
      yield data.content.map((dto) => parseBook(dto))
      if (data.last) return
    }
  }

  async download(book: RemoteBook): Promise<Buffer> {
    const res = await this.http.request('GET', book.downloadUrl, { timeoutMs: 120_000 })
    if (!res.ok || !res.value) throw new Error(res.error ?? `download failed: HTTP ${res.status}`)
    return res.value.bytes()
  }

  async fetchCover(book: RemoteBook): Promise<Buffer | null> {
    if (!book.coverUrl) return null
    const res = await this.http.request('GET', book.coverUrl)
    // Null means "this book has no art"; anything else is a failure worth
    // retrying, and must not be mistaken for a book without a cover.
    if (res.status === 404 || res.status === 204) return null
    if (!res.ok || !res.value) {
      throw new Error(res.error ?? `cover fetch failed: HTTP ${res.status}`)
    }
    return res.value.bytes()
  }

  async pullProgress(remoteId: string): Promise<PullResult> {
    const res = await this.http.request('GET', `/api/v1/books/${remoteId}/progression`)
    if (res.status === 204 || res.status === 404) return { status: 'missing' }
    if (!res.ok || !res.value) {
      return { status: 'error', detail: res.error ?? `HTTP ${res.status}` }
    }
    const data = await res.value.json<{ locator?: Locator; modified?: string }>()
    if (!data.locator) return { status: 'missing' }
    return {
      status: 'ok',
      record: {
        locator: data.locator,
        progression:
          data.locator.locations?.totalProgression ?? data.locator.locations?.progression,
        updatedAt: data.modified ? Date.parse(data.modified) : undefined,
      },
    }
  }

  async pushProgress(
    remoteId: string,
    progress: ProgressRecord,
  ): Promise<'ok' | 'stale' | 'rejected'> {
    if (!progress.locator) return 'rejected'
    // Komga's locator contract: relative href, required progression.
    const locator: Locator = {
      ...progress.locator,
      href: progress.locator.href.replace(/^\/+/, ''),
      type: progress.locator.type ?? 'application/xhtml+xml',
      locations: { ...progress.locator.locations },
    }
    const res = await this.http.request('PUT', `/api/v1/books/${remoteId}/progression`, {
      body: JSON.stringify({
        device: { id: 'liseur-desktop', name: 'Liseur Desktop' },
        locator,
        modified: new Date(progress.updatedAt ?? Date.now()).toISOString(),
      }),
      headers: { 'content-type': 'application/json' },
    })
    if (res.status === 409) return 'stale'
    if (res.status === 400) return 'rejected'
    return res.ok ? 'ok' : 'rejected'
  }

  async markCompleted(remoteId: string): Promise<void> {
    await this.http.request('PATCH', `/api/v1/books/${remoteId}/read-progress`, {
      body: JSON.stringify({ completed: true }),
      headers: { 'content-type': 'application/json' },
    })
  }
}
