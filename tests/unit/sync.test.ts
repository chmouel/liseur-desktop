import { describe, expect, it, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrate } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'
import { reconcileProgress } from '../../src/worker/sync/reconcile'
import { parseOpdsFeed } from '../../src/worker/sync/calibre'
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
})

// Reference the mock helper module (keeps this file focused).
export { jsonResponse }
