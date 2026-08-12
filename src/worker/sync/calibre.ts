import { scanXml } from '../epub/xml'
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
 * calibre-web: OPDS 1.x catalog (Basic auth) + Kobo-protocol progress sync
 * (`/kobo/<token>/v1/library/...`). Mirrors the Android client
 * (data/calibre/*): catalog walks /opds/books/letter/00 following rel=next,
 * progress via per-book ReadingStates with ProgressPercent.
 */

const KOBO_STATUS = { unread: 'ReadyToRead', reading: 'Reading', finished: 'Finished' } as const

interface OpdsEntry {
  id: string
  title: string
  author?: string | undefined
  updated?: string | undefined
  links: { rel: string; href: string; length?: number | undefined }[]
}

/** Parses an OPDS feed with the XML scanner (calibre-web serves XML). */
export function parseOpdsFeed(xml: string): {
  entries: OpdsEntry[]
  nextHref?: string | undefined
} {
  const entries: OpdsEntry[] = []
  let nextHref: string | undefined

  let entry: OpdsEntry | undefined
  let collector: { set: (text: string) => void } | undefined
  let textBuffer = ''
  let inAuthorName = false

  scanXml(xml, {
    onStart: (el) => {
      if (el.localName === 'entry') {
        entry = { id: '', title: '', links: [] }
        return
      }
      if (!entry) {
        if (el.localName === 'link' && el.attributes['rel'] === 'next' && el.attributes['href']) {
          nextHref = el.attributes['href']
        }
        return
      }
      if (el.localName === 'link') {
        const rel = el.attributes['rel'] ?? ''
        const href = el.attributes['href']
        if (href) {
          const length = el.attributes['length']
          entry.links.push({ rel, href, length: length ? Number(length) : undefined })
        }
      } else if (el.localName === 'id' || el.localName === 'title' || el.localName === 'updated') {
        textBuffer = ''
        collector = {
          set: (text) => {
            if (el.localName === 'id') entry!.id = text
            else if (el.localName === 'title') entry!.title = text
            else entry!.updated = text
          },
        }
      } else if (el.localName === 'name') {
        inAuthorName = true
        textBuffer = ''
      }
    },
    onText: (text) => {
      if (collector || inAuthorName) textBuffer += text
    },
    onEnd: (_name, localName) => {
      if (localName === 'entry' && entry) {
        entries.push(entry)
        entry = undefined
        return
      }
      if (!entry) return
      if (collector && (localName === 'id' || localName === 'title' || localName === 'updated')) {
        collector.set(textBuffer.trim())
        collector = undefined
      } else if (localName === 'name' && inAuthorName) {
        entry.author = textBuffer.trim()
        inAuthorName = false
      }
    },
  })
  return { entries, nextHref }
}

const REL_ACQUISITION = 'http://opds-spec.org/acquisition'
const REL_IMAGE = 'http://opds-spec.org/image'
const REL_THUMBNAIL = 'http://opds-spec.org/image/thumbnail'

function entryToBook(entry: OpdsEntry): RemoteBook | null {
  const download = entry.links.find((l) => l.rel === REL_ACQUISITION)
  if (!download) return null
  const uuid = entry.id.replace(/^urn:uuid:/, '')
  return {
    remoteId: uuid,
    title: entry.title || uuid,
    authors: entry.author ? [entry.author] : [],
    sizeBytes: download.length,
    downloadUrl: download.href,
    coverUrl: entry.links.find((l) => l.rel === REL_IMAGE || l.rel === REL_THUMBNAIL)?.href,
  }
}

export class CalibreCatalog implements RemoteCatalog {
  private readonly http: Http
  private readonly koboHttp: Http | null

  constructor(
    readonly server: RemoteServer,
    authHeaders: Record<string, string>,
    koboToken?: string,
    fetchImpl?: ConstructorParameters<typeof Http>[2],
  ) {
    this.http = new Http(server.url, authHeaders, fetchImpl)
    this.koboHttp = koboToken
      ? new Http(`${server.url}/kobo/${koboToken}`, authHeaders, fetchImpl)
      : null
  }

  async testConnection(): Promise<TestResult> {
    const res = await this.http.request('GET', '/opds')
    if (res.status === 401) return { ok: false, detail: 'invalid username or password' }
    if (!res.ok || !res.value) return { ok: false, detail: res.error ?? `HTTP ${res.status}` }
    const body = await res.value.text()
    if (!body.includes('<feed')) return { ok: false, detail: 'not an OPDS server' }
    return { ok: true }
  }

  async *listBooks(query?: string): AsyncIterable<RemoteBook[]> {
    let path: string | undefined = query
      ? `/opds/search?query=${encodeURIComponent(query)}`
      : '/opds/books/letter/00'
    let pages = 0
    while (path && pages++ < MAX_PAGES) {
      const res = await this.http.request('GET', path)
      // Treating a refused feed as an empty one hides a broken server
      // behind a library that simply looks empty.
      if (!res.ok || !res.value) {
        throw new Error(res.error ?? `catalog listing failed: HTTP ${res.status}`)
      }
      const { entries, nextHref } = parseOpdsFeed(await res.value.text())
      const books = entries.map(entryToBook).filter((b): b is RemoteBook => b !== null)
      if (books.length > 0) yield books
      path = nextHref
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
    if (!res.ok || !res.value) return null
    return res.value.bytes()
  }

  // --- Kobo-protocol progress sync -------------------------------------------

  async pullProgress(remoteId: string): Promise<PullResult> {
    if (!this.koboHttp) return { status: 'error', detail: 'no kobo token' }
    const res = await this.koboHttp.request('GET', `/v1/library/${remoteId}/state`)
    if (res.status === 404) return { status: 'missing' }
    if (!res.ok || !res.value) {
      return { status: 'error', detail: res.error ?? `HTTP ${res.status}` }
    }
    const data = await res.value.json<
      {
        CurrentBookmark?: {
          ProgressPercent?: number
          LastModified?: string
        }
        StatusInfo?: { Status?: string; LastModified?: string }
      }[]
    >()
    const state = data[0]
    if (!state) return { status: 'missing' }
    const percent = state.CurrentBookmark?.ProgressPercent
    return {
      status: 'ok',
      record: {
        progression: percent !== undefined ? percent / 100 : undefined,
        completed: state.StatusInfo?.Status === KOBO_STATUS.finished,
        updatedAt:
          Date.parse(state.CurrentBookmark?.LastModified ?? state.StatusInfo?.LastModified ?? '') ||
          undefined,
      },
    }
  }

  async pushProgress(
    remoteId: string,
    progress: ProgressRecord,
  ): Promise<'ok' | 'stale' | 'rejected'> {
    if (!this.koboHttp) return 'rejected'
    const percent = Math.round((progress.progression ?? 0) * 1000) / 10
    const status =
      progress.completed || progress.progression === 1
        ? KOBO_STATUS.finished
        : progress.progression
          ? KOBO_STATUS.reading
          : KOBO_STATUS.unread
    const res = await this.koboHttp.request('PUT', `/v1/library/${remoteId}/state`, {
      body: JSON.stringify({
        ReadingStates: [
          {
            CurrentBookmark: {
              ProgressPercent: percent,
              ContentSourceProgressPercent: percent,
              Location: null, // calibre-web rejects kobo locations it can't parse
            },
            Statistics: null,
            StatusInfo: { Status: status },
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    })
    return res.ok ? 'ok' : 'rejected'
  }
}

const MAX_PAGES = 500

/** The web-login dance that provisions a Kobo sync token (setup time only). */
export async function provisionKoboToken(
  serverUrl: string,
  username: string,
  password: string,
  fetchImpl?: ConstructorParameters<typeof Http>[2],
): Promise<{ userId: string; token: string } | null> {
  const http = new Http(serverUrl, {}, fetchImpl)
  // Session cookie via the web login form (CSRF included when present).
  const loginPage = await http.request('GET', '/login')
  if (!loginPage.ok || !loginPage.value) return null
  const loginHtml = await loginPage.value.text()
  const csrf = /name="csrf_token"[^>]*value="([^"]+)"/.exec(loginHtml)?.[1]
  const cookie = loginPage.value.headers.get('set-cookie')?.split(';')[0] ?? ''

  const form = new URLSearchParams({
    username,
    password,
    submit: '',
    next: '/',
    ...(csrf ? { csrf_token: csrf } : {}),
  })
  const login = await http.request('POST', '/login', {
    body: form.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
  })
  const sessionCookie = (login.value?.headers.get('set-cookie') ?? cookie).split(';')[0] ?? ''
  if (!sessionCookie) return null

  const me = await http.request('GET', '/me', { headers: { cookie: sessionCookie } })
  if (!me.ok || !me.value) return null
  const userId = /\/users\/(\d+)/.exec(await me.value.text())?.[1]
  if (!userId) return null

  const tokenPage = await http.request('GET', `/kobo_auth/generate_auth_token/${userId}`, {
    headers: { cookie: sessionCookie },
  })
  if (!tokenPage.ok || !tokenPage.value) return null
  const token = /\/kobo\/([0-9a-fA-F]{32})/.exec(await tokenPage.value.text())?.[1]
  return token ? { userId, token } : null
}
