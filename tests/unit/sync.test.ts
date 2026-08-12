import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'
import { reconcileProgress } from '../../src/worker/sync/reconcile'
import { CalibreCatalog, parseOpdsFeed } from '../../src/worker/sync/calibre'
import { KomgaCatalog } from '../../src/worker/sync/komga'
import { SyncRepository } from '../../src/worker/sync/sync-repository'
import { BookRepository } from '../../src/worker/library/book-repository'
import { SyncService } from '../../src/worker/sync/sync-service'
import type { FetchLike } from '../../src/worker/sync/http'
import { jsonResponse, mockKomga } from './sync-mocks'

// --- reconcile matrix --------------------------------------------------------

describe('reconcileProgress', () => {
  const local = (progression: number, updatedAt: number) => ({
    progression,
    updatedAt,
    locator: { href: 'ch1.xhtml' },
  })
  const remote = (progression: number, updatedAt: number) => ({
    progression,
    updatedAt,
    locator: { href: 'ch1.xhtml' },
  })

  it('none when both empty', () => {
    expect(reconcileProgress(null, null, false)).toBe('none')
  })

  it('pull when only remote exists', () => {
    expect(reconcileProgress(null, remote(0.5, 100), false)).toBe('pull')
  })

  it('push when only local exists', () => {
    expect(reconcileProgress(local(0.5, 100), null, true)).toBe('push')
  })

  it('none within epsilon', () => {
    expect(reconcileProgress(local(0.5, 100), remote(0.504, 200), true)).toBe('none')
  })

  it('conflict when both changed and diverged', () => {
    expect(reconcileProgress(local(0.5, 100), remote(0.9, 200), true)).toBe('conflict')
  })

  it('push when local dirty and newer', () => {
    expect(reconcileProgress(local(0.9, 300), remote(0.5, 200), true)).toBe('push')
  })

  it('pull when only remote changed', () => {
    expect(reconcileProgress(local(0.3, 100), remote(0.9, 200), false)).toBe('pull')
  })

  it('adopt-status when remote completed without position', () => {
    expect(reconcileProgress(local(0.3, 100), { completed: true, updatedAt: 200 }, false)).toBe(
      'adopt-status',
    )
  })
})

// --- OPDS parsing --------------------------------------------------------------

describe('parseOpdsFeed', () => {
  const feed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <entry>
    <id>urn:uuid:abc-123</id>
    <title>The OPDS Book</title>
    <author><name>Jane Author</name></author>
    <updated>2026-01-01T00:00:00Z</updated>
    <link rel="http://opds-spec.org/image" href="/opds/cover/42"/>
    <link rel="http://opds-spec.org/acquisition" href="/opds/download/42/epub/" length="12345"/>
  </entry>
  <entry>
    <id>urn:uuid:def-456</id>
    <title>No Download Link</title>
  </entry>
  <link rel="next" href="/opds/books/letter/00?page=2"/>
</feed>`

  it('parses entries with acquisition links and next page', () => {
    const { entries, nextHref } = parseOpdsFeed(feed)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ id: 'urn:uuid:abc-123', title: 'The OPDS Book' })
    expect(entries[0]?.author).toBe('Jane Author')
    expect(entries[0]?.links).toContainEqual(
      expect.objectContaining({ rel: 'http://opds-spec.org/acquisition', length: 12345 }),
    )
    expect(nextHref).toBe('/opds/books/letter/00?page=2')
  })
})

// --- sync queue ---------------------------------------------------------------

describe('SyncRepository queue', () => {
  let db: DatabaseSync
  let repo: SyncRepository

  beforeEach(() => {
    db = openDatabase(':memory:')
    migrate(db, MIGRATIONS)
    repo = new SyncRepository(db)
    db.prepare(
      `INSERT INTO books (id, title, authors, finished, archived, downloaded, added_at)
       VALUES ('b1', 'Book', '[]', 0, 0, 1, 0)`,
    ).run()
  })

  it('coalesces per book: latest wins, survives re-open', () => {
    repo.enqueue('b1', { href: 'a' }, 0.3, 100)
    repo.enqueue('b1', { href: 'b' }, 0.6, 200)
    const queue = repo.queue()
    expect(queue).toHaveLength(1)
    expect(queue[0]?.progression).toBe(0.6)
    expect(repo.queueSize()).toBe(1)
    repo.dequeue('b1')
    expect(repo.queueSize()).toBe(0)
  })

  it('servers: add, list, mark synced, remove unlinks books', () => {
    const server = repo.addServer({ type: 'komga', name: 'K', url: 'http://k.test/' })
    expect(repo.getServer(server.id)?.url).toBe('http://k.test')
    db.prepare("UPDATE books SET server_id = ?, remote_id = 'r1' WHERE id = 'b1'").run(server.id)
    repo.removeServer(server.id)
    expect(repo.listServers()).toHaveLength(0)
    expect(
      (db.prepare('SELECT server_id FROM books WHERE id = ?').get('b1') as { server_id: null })
        .server_id,
    ).toBeNull()
  })

  it('conflicts: add, list with title, resolve (target-scoped)', () => {
    const server = repo.addServer({ type: 'komga', name: 'K', url: 'http://k.test' })
    repo.addConflict({
      bookId: 'b1',
      serverId: server.id,
      remoteId: 'r1',
      localLocator: { href: 'a' },
      localProgression: 0.3,
      localUpdatedAt: 100,
      remoteLocator: { href: 'b' },
      remoteProgression: 0.6,
      remoteUpdatedAt: 200,
    })
    const conflicts = repo.conflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.bookTitle).toBe('Book')
    expect(conflicts[0]?.serverName).toBe('K')
    expect(repo.hasConflict('b1', server.id)).toBe(true)
    expect(repo.hasConflict('b1', 'other')).toBe(false)
    repo.resolveConflict('b1', server.id)
    expect(repo.conflicts()).toHaveLength(0)
  })
})

// --- SyncService with a mock Komga server --------------------------------------

describe('SyncService against mock Komga', () => {
  let db: DatabaseSync
  let dataDir: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    migrate(db, MIGRATIONS)
    dataDir = mkdtempSync(join(tmpdir(), 'liseur-sync-test-'))
  })

  function makeService(fetchImpl: FetchLike) {
    const events: { added: string[]; updated: string[] } = { added: [], updated: [] }
    const secrets: Record<string, Record<string, string>> = {}
    const service = new SyncService(db, dataDir, {
      onBookAdded: (b) => events.added.push(b.id),
      onBookUpdated: (b) => events.updated.push(b.id),
      onStateChanged: () => {},
      storeSecret: async (id, headers) => {
        secrets[id] = headers
      },
      clearSecret: (id) => {
        delete secrets[id]
      },
      fetchImpl,
    })
    return { service, events, secrets }
  }

  it('setup → catalog sync → download → progress push', async () => {
    const komga = mockKomga()
    const { service, events, secrets } = makeService(komga.fetch)

    const { server, test } = await service.setupServer({
      type: 'komga',
      name: 'Test Komga',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    expect(test.ok).toBe(true)
    // API key persisted as a header via the secret store callback, never the URL.
    expect(secrets[server.id]).toEqual({ 'x-api-key': 'api-key-1' })
    service.setCredentials(server.id, { headers: secrets[server.id]! })

    const sync = await service.syncNow(server.id)
    expect(sync.error).toBeUndefined()
    expect(sync.added).toBe(2)
    expect(events.added).toHaveLength(2)

    // Books are remote shells: not downloaded, cloud identity set.
    const state = service.state()
    expect(state.servers[0]?.hasCredentials).toBe(true)

    // Download the first book.
    const repo = new SyncRepository(db)
    const shell = repo.findByRemoteId(server.id, 'book-1')
    expect(shell).toBeDefined()
    expect(shell?.localPath).toBeUndefined()

    const downloaded = await service.downloadBook(shell!.id)
    expect(downloaded?.localPath).toContain('downloads')
    expect(downloaded?.downloaded).toBe(true)

    // Progress push flows through the queue to the server.
    service.enqueueProgress(downloaded!, { href: 'ch1.xhtml' }, 0.5)
    await service.flushQueue()
    expect(komga.progressPushes).toHaveLength(1)
    expect(komga.progressPushes[0]?.locator.href).toBe('ch1.xhtml')
    expect(service.state().queueSize).toBe(0)
  })

  it('testConnection surfaces auth failure (server kept for fixing credentials)', async () => {
    const komga = mockKomga({ failAuth: true })
    const { service } = makeService(komga.fetch)
    const { server, test } = await service.setupServer({
      type: 'komga',
      name: 'Bad',
      url: 'http://komga.test',
      secret: 'wrong',
    })
    expect(test.ok).toBe(false)
    // The server config stays so the user can fix credentials; the settings
    // form removes it explicitly on failure.
    expect(new SyncRepository(db).listServers()).toHaveLength(1)
    service.removeServer(server.id)
    expect(new SyncRepository(db).listServers()).toHaveLength(0)
  })

  it('adding a server fills the shelf without anyone pressing Sync now', async () => {
    // A server that connects but leaves the library empty looks broken.
    // Deliberately never calls syncNow: the point is that nothing has to.
    const komga = mockKomga()
    const { service, events } = makeService(komga.fetch)

    const { server, test } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    expect(test.ok).toBe(true)

    await vi.waitFor(() => {
      expect(events.added).toHaveLength(2)
      expect(new SyncRepository(db).findByRemoteId(server.id, 'book-1')).toBeDefined()
    })
  })

  it('credentials arriving at startup pull the catalog exactly once', async () => {
    const komga = mockKomga()
    const { service, events } = makeService(komga.fetch)
    const server = new SyncRepository(db).addServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
    })

    service.setCredentials(server.id, { headers: { 'x-api-key': 'api-key-1' } })
    service.catchUp(server.id)
    await vi.waitFor(() => expect(events.added).toHaveLength(2))

    // Credentials are re-pushed on every renderer connect. That is a
    // catch-up, not a poll: asking again must not sync again.
    const listsBefore = komga.bookListRequests
    service.catchUp(server.id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(komga.bookListRequests).toBe(listsBefore)
  })

  it('a catalog book gets its cover only when something asks for it', async () => {
    const komga = mockKomga()
    const { service, events } = makeService(komga.fetch)
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    await service.syncNow(server.id)

    const repo = new SyncRepository(db)
    const books = new BookRepository(db)
    const shell = repo.findByRemoteId(server.id, 'book-1')!
    // Sync leaves the art alone: a few thousand books must not mean a few
    // thousand image requests for covers nobody has scrolled to.
    expect(books.getById(shell.id)?.coverId).toBeUndefined()

    service.ensureCover(shell.id)
    await vi.waitFor(() => expect(books.getById(shell.id)?.coverId).toBeDefined())
    const coverId = books.getById(shell.id)!.coverId!
    expect(existsSync(join(dataDir, 'covers', coverId))).toBe(true)
    expect(events.updated).toContain(shell.id)

    // Already cached: asking again is a no-op, not a second fetch.
    const updatesBefore = events.updated.length
    service.ensureCover(shell.id)
    await new Promise((r) => setTimeout(r, 20))
    expect(events.updated).toHaveLength(updatesBefore)

    // A server with no art for a book is not an error.
    const noArt = repo.findByRemoteId(server.id, 'book-2')!
    service.ensureCover(noArt.id)
    await new Promise((r) => setTimeout(r, 20))
    expect(books.getById(noArt.id)?.coverId).toBeUndefined()
  })

  it('a screenful of covers is fetched a few at a time, and all of them arrive', async () => {
    // Each request's timeout starts when it is created, not when a
    // connection frees up. Firing seventy at once meant the ones at the
    // back timed out while still queued: a library whose first twenty
    // books had art and whose rest were placeholders forever.
    const COUNT = 40
    let inFlight = 0
    let peak = 0
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname
      if (path === '/api/v2/users/me') return jsonResponse({ roles: ['ROLE_USER'] })
      if (path === '/api/v1/books/list') {
        return jsonResponse({
          content: Array.from({ length: COUNT }, (_, i) => ({
            id: `b${i}`,
            name: `Book ${i}`,
            metadata: { title: `Book ${i}`, authors: [] },
            media: { pagesCount: 10 },
          })),
          last: true,
        })
      }
      if (path.endsWith('/thumbnail')) {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      }
      return jsonResponse({}, 404)
    }

    const { service } = makeService(fetchImpl)
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    await service.syncNow(server.id)

    const repo = new SyncRepository(db)
    const books = new BookRepository(db)
    const ids = Array.from({ length: COUNT }, (_, i) => repo.findByRemoteId(server.id, `b${i}`)!.id)
    ids.forEach((id) => service.ensureCover(id))

    await vi.waitFor(() => expect(ids.every((id) => books.getById(id)?.coverId)).toBe(true), {
      timeout: 5_000,
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1) // still concurrent, not one at a time
  })

  it('a cover that failed on a bad connection is tried again, but not forever', async () => {
    // A timeout is not "this book has no cover". Without a retry a single
    // flaky moment left a placeholder until the app was restarted.
    let flakyAttempts = 0
    let deadAttempts = 0
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname
      if (path === '/api/v2/users/me') return jsonResponse({ roles: ['ROLE_USER'] })
      if (path === '/api/v1/books/list') {
        return jsonResponse({
          content: [
            { id: 'flaky', name: 'Flaky', metadata: { title: 'Flaky', authors: [] } },
            { id: 'dead', name: 'Dead', metadata: { title: 'Dead', authors: [] } },
            { id: 'artless', name: 'Artless', metadata: { title: 'Artless', authors: [] } },
          ],
          last: true,
        })
      }
      if (path === '/api/v1/books/flaky/thumbnail') {
        flakyAttempts++
        if (flakyAttempts < 2) throw new Error('connection reset')
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      }
      if (path === '/api/v1/books/dead/thumbnail') {
        deadAttempts++
        throw new Error('connection reset')
      }
      return jsonResponse({}, 404) // artless: the server has no art for it
    }

    const { service } = makeService(fetchImpl)
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    await service.syncNow(server.id)

    const repo = new SyncRepository(db)
    const books = new BookRepository(db)
    const flaky = repo.findByRemoteId(server.id, 'flaky')!.id
    const dead = repo.findByRemoteId(server.id, 'dead')!.id
    const artless = repo.findByRemoteId(server.id, 'artless')!.id
    ;[flaky, dead, artless].forEach((id) => service.ensureCover(id))

    await vi.waitFor(() => expect(books.getById(flaky)?.coverId).toBeDefined())

    // The one that never answers stops after a bounded number of tries: an
    // idle app must not sit there retrying.
    await vi.waitFor(() => expect(deadAttempts).toBe(3))
    await new Promise((r) => setTimeout(r, 50))
    expect(deadAttempts).toBe(3)
    expect(books.getById(dead)?.coverId).toBeUndefined()

    // A 404 means the book has no art: one look, no retries.
    expect(books.getById(artless)?.coverId).toBeUndefined()
  })

  it('asks Komga for ready EPUBs in the shape its search DSL accepts', async () => {
    // Komga rejects a bare `{ mediaProfile: 'EPUB' }` with HTTP 400. That
    // 400 used to end the walk quietly, so a working server showed an
    // empty library and still reported a successful sync.
    const bodies: string[] = []
    const komga = mockKomga()
    const catalog = new KomgaCatalog(
      { id: 's1', type: 'komga', name: 'K', url: 'http://komga.test', addedAt: 0 },
      { 'x-api-key': 'api-key-1' },
      (url, init) => {
        if (new URL(url).pathname === '/api/v1/books/list') bodies.push(String(init?.body))
        return komga.fetch(url, init)
      },
    )
    for await (const _page of catalog.listBooks()) void _page

    const body = JSON.parse(bodies[0] ?? '{}') as {
      condition?: { allOf?: Record<string, { operator: string; value: string }>[] }
    }
    const filters = body.condition?.allOf ?? []
    expect(filters[0]?.mediaProfile).toEqual({ operator: 'is', value: 'EPUB' })
    expect(filters[1]?.mediaStatus).toEqual({ operator: 'is', value: 'READY' })
  })

  it('a search puts its text beside the condition, not inside it', async () => {
    const bodies: string[] = []
    const komga = mockKomga()
    const catalog = new KomgaCatalog(
      { id: 's1', type: 'komga', name: 'K', url: 'http://komga.test', addedAt: 0 },
      { 'x-api-key': 'api-key-1' },
      (url, init) => {
        if (new URL(url).pathname === '/api/v1/books/list') bodies.push(String(init?.body))
        return komga.fetch(url, init)
      },
    )
    for await (const _page of catalog.listBooks('dune')) void _page

    const body = JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>
    expect(body.fullTextSearch).toBe('dune')
    expect(body.condition).not.toHaveProperty('fullTextSearch')
  })

  it('a rejected catalog page fails the sync instead of emptying the shelf', async () => {
    const komga = mockKomga()
    const { service } = makeService((url, init) =>
      new URL(url).pathname === '/api/v1/books/list'
        ? Promise.resolve(jsonResponse({ error: 'Bad Request' }, 400))
        : komga.fetch(url, init),
    )
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    const result = await service.syncNow(server.id)

    expect(result.error).toContain('400')
    expect(result.added).toBe(0)
    // The server must not claim it synced, and the failure has to be
    // visible to someone who never pressed a button.
    expect(new SyncRepository(db).listServers()[0]?.lastSyncAt).toBeUndefined()
    expect(service.state().lastError).toContain('400')
  })

  it('a refused OPDS feed fails the sync instead of emptying the shelf', async () => {
    const catalog = new CalibreCatalog(
      { id: 's1', type: 'calibre-web', name: 'C', url: 'http://calibre.test', addedAt: 0 },
      {},
      undefined,
      () => Promise.resolve(new Response('nope', { status: 500 })),
    )
    await expect(async () => {
      for await (const _page of catalog.listBooks()) void _page
    }).rejects.toThrow(/500/)
  })

  it('komga listBooks parses pages via the catalog client', async () => {
    const komga = mockKomga()
    const catalog = new KomgaCatalog(
      { id: 's1', type: 'komga', name: 'K', url: 'http://komga.test', addedAt: 0 },
      { 'x-api-key': 'api-key-1' },
      komga.fetch,
    )
    const pages: string[][] = []
    for await (const page of catalog.listBooks()) pages.push(page.map((b) => b.remoteId))
    expect(pages.flat()).toEqual(['book-1', 'book-2'])
  })

  it('pull errors never drive reconciliation (no push on server failure)', async () => {
    const komga = mockKomga()
    const { service } = makeService(komga.fetch)
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    service.setCredentials(server.id, { headers: { 'x-api-key': 'api-key-1' } })
    await service.syncNow(server.id)

    const repo = new SyncRepository(db)
    const shell = repo.findByRemoteId(server.id, 'book-1')!
    await service.downloadBook(shell.id)

    // Local progress EXISTS but is not dirty (not queued); then the server
    // starts failing pulls.
    const books = new BookRepository(db)
    books.setProgress(shell.id, { href: 'ch1.xhtml' }, 0.4, Date.now())
    komga.state.failPulls = true
    await service.syncNow(server.id)
    // A pull error is not "no progress": nothing was pushed, no conflict.
    expect(komga.progressPushes).toHaveLength(0)
    expect(service.conflicts()).toHaveLength(0)
    expect(service.state().queueSize).toBe(0)
  })

  it('a newer enqueue during a flush is not dequeued by the older push', async () => {
    const repo = new SyncRepository(db)
    let shellId = ''
    // The mock enqueues a newer row INSIDE the push request handler.
    const komga = mockKomga({
      onPush: () => repo.enqueue(shellId, { href: 'b' }, 0.7, 200),
    })
    const { service } = makeService(komga.fetch)
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    service.setCredentials(server.id, { headers: { 'x-api-key': 'api-key-1' } })
    await service.syncNow(server.id)
    const shell = repo.findByRemoteId(server.id, 'book-1')!
    shellId = shell.id

    repo.enqueue(shell.id, { href: 'a' }, 0.3, 100)
    await service.flushQueue()
    expect(komga.progressPushes).toHaveLength(1)
    // The older push's dequeue must not remove the mid-flight newer row.
    const remaining = repo.queue()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.progression).toBe(0.7)
  })

  it('conflicts suspend the queue row until resolved', async () => {
    const komga = mockKomga({ conflictOnPush: true })
    const repo = new SyncRepository(db)
    const { service } = makeService(komga.fetch)
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    service.setCredentials(server.id, { headers: { 'x-api-key': 'api-key-1' } })
    await service.syncNow(server.id)
    const shell = repo.findByRemoteId(server.id, 'book-1')!

    // Local is dirty; server reports a newer divergent position on stale pull.
    service.enqueueProgress(shell, { href: 'a' }, 0.3)
    await service.flushQueue()
    expect(service.conflicts()).toHaveLength(1)
    // Suspended: a second flush pushes nothing more.
    const pushes = komga.progressPushes.length
    await service.flushQueue()
    expect(komga.progressPushes.length).toBe(pushes)

    // Resolve for the server side: the row is acked for that target and the
    // next flush dequeues it (delivery confirmed).
    await service.resolveConflict(shell.id, server.id, 'server')
    expect(service.conflicts()).toHaveLength(0)
    await service.flushQueue()
    expect(repo.queue()).toHaveLength(0)
  })

  it('a position dated in the future does not outrank what you read today', async () => {
    // A device with a fast clock (or a server in the wrong timezone) dated
    // a position an hour ahead. It beat every real position from then on:
    // the book stuck to the Continue Reading banner and to the top of
    // Recent, and would not move until the clock caught up with it.
    const future = Date.now() + 3 * 3_600_000
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname
      if (path === '/api/v2/users/me') return jsonResponse({ roles: ['ROLE_USER'] })
      if (path === '/api/v1/books/list') {
        return jsonResponse({
          content: [
            {
              id: 'book-1',
              name: 'Guidebook',
              metadata: { title: 'Guidebook', authors: [] },
              media: { pagesCount: 100 },
              readProgress: { page: 27, completed: false },
            },
          ],
          last: true,
        })
      }
      if (path.endsWith('/progression')) {
        return jsonResponse({
          locator: { href: 'ch1.xhtml', locations: { totalProgression: 0.27 } },
          modified: new Date(future).toISOString(),
        })
      }
      return jsonResponse({}, 404)
    }

    const { service } = makeService(fetchImpl)
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    await service.syncNow(server.id)

    const repo = new SyncRepository(db)
    const books = new BookRepository(db)
    const synced = books.getById(repo.findByRemoteId(server.id, 'book-1')!.id)!
    expect(synced.progress?.progression).toBeCloseTo(0.27)
    expect(synced.progress?.updatedAt).toBeLessThanOrEqual(Date.now())

    // A position arriving from a server is not you opening the book, so it
    // must not claim the shelf's "recently opened" slot either.
    expect(synced.lastOpenedAt).toBeUndefined()

    // Worse than the ordering: a position dated in the future looks newer
    // than the page you are actually on, so the server's stale position
    // won every comparison and picked a fight with your real one.
    const read = books.setProgress(synced.id, { href: 'ch9.xhtml' }, 0.8, Date.now())
    service.enqueueProgress(read, { href: 'ch9.xhtml' }, 0.8)
    await service.syncNow(server.id)
    expect(service.conflicts()).toHaveLength(0)
    expect(books.getById(synced.id)?.progress?.progression).toBeCloseTo(0.8)
  })

  it('a sync of an untouched shelf does not ask about every book', async () => {
    // Komga puts read progress on every book in a listing page, so asking
    // again book by book is a round trip per book on every single sync: on
    // a shelf of a few thousand, minutes of pointless requests.
    const read = new Set(['book-1'])
    const pushed: string[] = []
    let progressRequests = 0
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname
      if (path === '/api/v2/users/me') return jsonResponse({ roles: ['ROLE_USER'] })
      if (path === '/api/v1/books/list') {
        return jsonResponse({
          content: Array.from({ length: 30 }, (_, i) => ({
            id: `book-${i}`,
            name: `Book ${i}`,
            metadata: { title: `Book ${i}`, authors: [] },
            media: { pagesCount: 100 },
            ...(read.has(`book-${i}`) ? { readProgress: { page: 50, completed: false } } : {}),
          })),
          last: true,
        })
      }
      if (path.endsWith('/progression')) {
        if (init?.method === 'PUT') {
          pushed.push(path.split('/')[4]!)
          return new Response(null, { status: 204 })
        }
        progressRequests++
        return jsonResponse({
          locator: { href: 'ch1.xhtml', locations: { totalProgression: 0.5 } },
          modified: new Date(1_000).toISOString(),
        })
      }
      return jsonResponse({}, 404)
    }

    const { service } = makeService(fetchImpl)
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    await service.syncNow(server.id)

    // One request, for the one book the listing said had been read.
    expect(progressRequests).toBe(1)
    const repo = new SyncRepository(db)
    const books = new BookRepository(db)
    const readBook = repo.findByRemoteId(server.id, 'book-1')!
    expect(books.getById(readBook.id)?.progress?.progression).toBeCloseTo(0.5)

    // A book we have read locally still reaches the server even though the
    // listing called it untouched.
    const mine = repo.findByRemoteId(server.id, 'book-7')!
    service.enqueueProgress(mine, { href: 'ch2.xhtml' }, 0.8)
    await service.syncNow(server.id)
    expect(pushed).toContain('book-7')
    expect(progressRequests).toBe(2) // still only the one read book
  })

  it('a window left open picks up books added to the server later', async () => {
    // The catalog was pulled once per process, so a book added on the
    // server never showed up until the app was restarted.
    const titles = ['Book One']
    let listings = 0
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname
      if (path === '/api/v2/users/me') return jsonResponse({ roles: ['ROLE_USER'] })
      if (path === '/api/v1/books/list') {
        listings++
        return jsonResponse({
          content: titles.map((title, i) => ({
            id: `book-${i}`,
            name: title,
            metadata: { title, authors: [] },
            media: { pagesCount: 100 },
          })),
          last: true,
        })
      }
      return jsonResponse({}, 404)
    }

    const { service } = makeService(fetchImpl)
    const { server } = await service.setupServer({
      type: 'komga',
      name: 'K',
      url: 'http://komga.test',
      secret: 'api-key-1',
    })
    await service.syncNow(server.id)
    const repo = new SyncRepository(db)
    expect(repo.findByRemoteId(server.id, 'book-1')).toBeUndefined()

    // Coming back to a window that synced a second ago costs nothing.
    await service.refreshStale()
    expect(listings).toBe(1)

    // Coming back after a long time away picks up what appeared meanwhile.
    titles.push('Book Two')
    await service.refreshStale(0)
    expect(listings).toBe(2)
    expect(repo.findByRemoteId(server.id, 'book-1')?.title).toBe('Book Two')
  })

  it('two servers both fill the shelf, even when their catch-ups collide', async () => {
    // Credentials for every configured server arrive in the same tick at
    // startup. If the second catch-up is refused because the first is still
    // running, that server's books never appear until the next launch.
    const one = mockKomga()
    const two = mockKomga()
    const { service } = makeService(async (url, init) =>
      new URL(url).port === '9002' ? two.fetch(url, init) : one.fetch(url, init),
    )

    const a = await service.setupServer({
      type: 'komga',
      name: 'One',
      url: 'http://localhost:9001',
      secret: 'api-key-1',
    })
    const b = await service.setupServer({
      type: 'komga',
      name: 'Two',
      url: 'http://localhost:9002',
      secret: 'api-key-1',
    })

    service.catchUp(a.server.id)
    service.catchUp(b.server.id)
    await vi.waitFor(() => {
      expect(one.bookListRequests).toBeGreaterThan(0)
      expect(two.bookListRequests).toBeGreaterThan(0)
    })

    const shelved = (serverId: string) =>
      (
        db.prepare('SELECT COUNT(*) AS n FROM books WHERE server_id = ?').get(serverId) as {
          n: number
        }
      ).n
    expect(shelved(a.server.id)).toBeGreaterThan(0)
    expect(shelved(b.server.id)).toBeGreaterThan(0)
  })

  it('signs in to liseur-sync and keeps the device secret the server hands back', async () => {
    // Mirrors the server: POST /v1/login returns `auth_token`, POST
    // /v1/tokens answers 201 with the device secret under `secret`
    // (internal/api/routes.go).
    const requests: { path: string; auth: string | undefined; body: unknown }[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      const u = new URL(url)
      const headers = (init?.headers ?? {}) as Record<string, string>
      requests.push({
        path: u.pathname,
        auth: headers['authorization'],
        body: JSON.parse(String(init?.body ?? 'null')),
      })
      if (u.pathname === '/sync/v1/login') {
        return jsonResponse({ auth_token: 'login-secret', expires_in: 3600 })
      }
      if (u.pathname === '/sync/v1/tokens') {
        if (headers['authorization'] !== 'Bearer login-secret') {
          return jsonResponse({ error: 'invalid auth credential' }, 401)
        }
        return jsonResponse(
          {
            token_id: 't1',
            device_id: 'd1',
            name: 'liseur-desktop',
            scope: 'sync',
            secret: 'device-secret',
          },
          201,
        )
      }
      if (u.pathname === '/sync/v1/changes') return jsonResponse({ ops: [], high_water: '0' })
      return jsonResponse({ error: 'not found' }, 404)
    }

    const { service, secrets } = makeService(fetchImpl)
    const { test: result } = await service.setupServer({
      type: 'liseur-sync',
      name: 'Liszue',
      // A base path, as a reverse proxy hands out: every route hangs off it.
      url: 'https://books.example.com/sync/',
      username: 'reader',
      secret: 'password',
    })

    expect(result.ok).toBe(true)
    expect(requests.map((r) => r.path)).toEqual([
      '/sync/v1/login',
      '/sync/v1/tokens',
      '/sync/v1/changes',
    ])
    expect(requests[1]?.body).toEqual({ name: 'liseur-desktop', scope: 'sync' })
    // The device secret, not the hour-long login credential.
    expect(Object.values(secrets)[0]?.['authorization']).toBe('Bearer device-secret')
  })

  it('says why a liseur-sync sign-in failed instead of just "login failed"', async () => {
    const fetchImpl: FetchLike = async (url) =>
      new URL(url).pathname.endsWith('/v1/login')
        ? jsonResponse({ error: 'invalid credentials' }, 401)
        : jsonResponse({ error: 'not found' }, 404)

    const { service } = makeService(fetchImpl)
    const { test: result } = await service.setupServer({
      type: 'liseur-sync',
      name: 'Liszue',
      url: 'https://books.example.com/sync/',
      username: 'reader',
      secret: 'wrong',
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/401/)
    expect(result.detail).toMatch(/invalid credentials/)
  })
})

// Reference the mock helper module (keeps this file focused).
export { jsonResponse }
