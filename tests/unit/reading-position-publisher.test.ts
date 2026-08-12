import { describe, expect, it, vi } from 'vitest'
import type { Book, Locator } from '../../src/shared/domain/types'
import {
  ReadingPositionPublisher,
  type PositionUpdate,
} from '../../src/worker/reading-position-publisher'

/**
 * `ReadingPositionPublisher` unit tests, mirroring the Android
 * `ReadingPositionPublisherTest` this module ports: writes stay ordered,
 * sync only starts after the commit, a persistence failure retains
 * recoverability instead of wedging later writes, and the close write
 * (just another `publish()` call) follows every earlier write.
 */

function book(id: string): Book {
  return {
    id,
    title: `Book ${id}`,
    authors: [],
    downloaded: true,
    finished: false,
    archived: false,
    addedAt: 0,
  }
}

function update(bookId: string, progression: number, at = progression): PositionUpdate {
  const locator: Locator = { href: `ch-${progression}.xhtml` }
  return { bookId, locator, progression, updatedAt: at }
}

describe('ReadingPositionPublisher', () => {
  it('commits before signaling sync for a single update', async () => {
    const events: string[] = []
    const publisher = new ReadingPositionPublisher({
      setProgress: (bookId) => {
        events.push(`commit:${bookId}`)
        return book(bookId)
      },
      recordSession: () => {},
      enqueueSync: (b) => {
        events.push(`sync:${b.id}`)
      },
      onBookUpdated: (b) => events.push(`broadcast:${b.id}`),
    })

    await publisher.publish(update('a', 0.1))

    expect(events).toEqual(['commit:a', 'broadcast:a', 'sync:a'])
  })

  it('keeps writes ordered even when publishes are fired without awaiting one another', async () => {
    const committed: number[] = []
    const publisher = new ReadingPositionPublisher({
      setProgress: (bookId, _locator, progression) => {
        committed.push(progression ?? -1)
        return book(bookId)
      },
      recordSession: () => {},
      enqueueSync: () => {},
      onBookUpdated: () => {},
    })

    // Fired back to back, none awaited before the next — the same shape as
    // rapid page turns arriving faster than the previous IPC round-trip.
    const all = Promise.all([
      publisher.publish(update('a', 0.1)),
      publisher.publish(update('a', 0.2)),
      publisher.publish(update('a', 0.3)),
    ])
    await all

    expect(committed).toEqual([0.1, 0.2, 0.3])
  })

  it('a persistence failure rejects that publish but does not strand later writes', async () => {
    const committed: number[] = []
    const log = vi.fn()
    const publisher = new ReadingPositionPublisher({
      setProgress: (bookId, _locator, progression) => {
        if (progression === 0.2) throw new Error('disk full')
        committed.push(progression ?? -1)
        return book(bookId)
      },
      recordSession: () => {},
      enqueueSync: () => {},
      onBookUpdated: () => {},
      log,
    })

    const first = publisher.publish(update('a', 0.1))
    const second = publisher.publish(update('a', 0.2))
    const third = publisher.publish(update('a', 0.3))

    await expect(first).resolves.toBeUndefined()
    await expect(second).rejects.toThrow('disk full')
    // The failure never silently drops the update, and it never wedges the
    // publisher: the next write still commits.
    await expect(third).resolves.toBeUndefined()
    expect(committed).toEqual([0.1, 0.3])
  })

  it('a sync-enqueue failure rejects without repeating the already-committed write', async () => {
    let commits = 0
    const publisher = new ReadingPositionPublisher({
      setProgress: (bookId) => {
        commits++
        return book(bookId)
      },
      recordSession: () => {},
      enqueueSync: () => {
        throw new Error('queue full')
      },
      onBookUpdated: () => {},
      log: () => {},
    })

    await expect(publisher.publish(update('a', 0.5))).rejects.toThrow('queue full')
    expect(commits).toBe(1)
  })

  it('the close write (just another publish) follows every earlier write for the same book', async () => {
    const order: string[] = []
    const publisher = new ReadingPositionPublisher({
      setProgress: (bookId, locator) => {
        order.push(`write:${locator.href}`)
        return book(bookId)
      },
      recordSession: () => {},
      enqueueSync: (b) => order.push(`sync:${b.id}`),
      onBookUpdated: () => {},
    })

    // Two page turns, then the close-time final write — all fired without
    // awaiting each other, the way ReaderScreen fires them.
    const p1 = publisher.publish(update('a', 0.1))
    const p2 = publisher.publish(update('a', 0.2))
    const close = publisher.publish(update('a', 0.3))
    await Promise.all([p1, p2, close])

    expect(order).toEqual([
      'write:ch-0.1.xhtml',
      'sync:a',
      'write:ch-0.2.xhtml',
      'sync:a',
      'write:ch-0.3.xhtml',
      'sync:a',
    ])
  })
})
