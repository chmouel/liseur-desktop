import type { FetchLike } from '../../src/worker/sync/http'
import { buildReaderEpub } from './epub-fixture'

/**
 * Mock Komga server as an injectable fetch implementation: users/me,
 * books/list paging, file download (a real fixture EPUB), progression
 * GET/PUT recording pushes. No network involved.
 */

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function mockKomga(
  options: {
    failAuth?: boolean
    conflictOnPush?: boolean
    /** Runs inside the PUT /progression handler — lets tests enqueue a newer
     *  queue row mid-request to simulate the race. */
    onPush?: () => void
  } = {},
) {
  const progressPushes: { locator: { href: string }; progression?: number }[] = []
  const state = { failPulls: false }
  const counters = { bookListRequests: 0 }
  const epub = buildReaderEpub({ chapters: 2 })

  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const apiKey = headers['x-api-key']
    if (options.failAuth || apiKey !== 'api-key-1') {
      return jsonResponse({ error: 'unauthorized' }, 401)
    }

    if (u.pathname === '/api/v2/users/me') {
      return jsonResponse({ roles: ['ROLE_USER', 'FILE_DOWNLOAD'] })
    }
    if (u.pathname === '/api/v1/books/list' && init?.method === 'POST') {
      // Komga validates the search DSL: every leaf must be an operator
      // object. Rejecting anything else here is what keeps this mock
      // honest about the shape the real server accepts.
      const body = JSON.parse(String(init.body ?? '{}')) as {
        condition?: { allOf?: Record<string, unknown>[] }
      }
      const leaves = body.condition?.allOf ?? []
      const wellFormed =
        leaves.length > 0 &&
        leaves.every((leaf) =>
          Object.values(leaf).every(
            (v) => typeof v === 'object' && v !== null && 'operator' in v && 'value' in v,
          ),
        )
      if (!wellFormed) {
        return jsonResponse({ error: 'Bad Request', message: 'malformed condition' }, 400)
      }
      const page = Number(u.searchParams.get('page') ?? '0')
      if (page === 0) counters.bookListRequests++
      const books = [
        {
          id: 'book-1',
          name: 'First Remote',
          sizeBytes: 1000,
          metadata: { title: 'First Remote', authors: [{ name: 'Remote Author', role: 'writer' }] },
          media: { pagesCount: 10 },
        },
        {
          id: 'book-2',
          name: 'Second Remote',
          sizeBytes: 2000,
          metadata: { title: 'Second Remote', authors: [{ name: 'Other Author' }] },
          media: { pagesCount: 20 },
        },
      ]
      return jsonResponse({ content: page === 0 ? books : [], last: page >= 0 })
    }
    if (u.pathname === '/api/v1/books/book-1/file') {
      return new Response(new Uint8Array(epub), { status: 200 })
    }
    if (u.pathname === '/api/v1/books/book-1/thumbnail') {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }
    if (u.pathname.endsWith('/progression')) {
      if (init?.method === 'PUT') {
        options.onPush?.() // mid-request hook for race simulation
        if (options.conflictOnPush) return jsonResponse({ error: 'stale' }, 409)
        progressPushes.push(JSON.parse(String(init.body)))
        return new Response(null, { status: 204 }) // null body: 204 forbids one
      }
      if (state.failPulls) return jsonResponse({ error: 'boom' }, 500)
      if (options.conflictOnPush) {
        // Server is strictly newer and divergent.
        return jsonResponse({
          locator: { href: 'ch9.xhtml', locations: { totalProgression: 0.9 } },
          modified: new Date(Date.now() + 10_000).toISOString(),
        })
      }
      return new Response(null, { status: 204 })
    }
    if (u.pathname.endsWith('/read-progress')) {
      return new Response(null, { status: 204 })
    }
    return jsonResponse({ error: 'not found' }, 404)
  }

  return {
    fetch: fetchImpl,
    progressPushes,
    state,
    /** How many catalog pulls the server has been asked for. */
    get bookListRequests() {
      return counters.bookListRequests
    },
  }
}
