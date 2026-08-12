import { describe, expect, it, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, migrate } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'
import { ReadingSessionRepository, IDLE_GAP_MS } from '../../src/worker/library/reading-sessions'

let db: DatabaseSync

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  db.prepare(
    `INSERT INTO books (id, title, authors, downloaded, finished, archived, added_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('b1', 'Book', '[]', 1, 0, 0, 0)
})

describe('ReadingSessionRepository', () => {
  it('joins page turns from one sitting into a single stretch', () => {
    const sessions = new ReadingSessionRepository(db)
    const t0 = 1_700_000_000_000
    sessions.record('b1', t0, 0.1)
    sessions.record('b1', t0 + 60_000, 0.2)
    sessions.record('b1', t0 + 120_000, 0.3)

    const all = sessions.forBook('b1')
    expect(all).toHaveLength(1)
    expect(all[0]?.startedAt).toBe(t0)
    expect(all[0]?.endedAt).toBe(t0 + 120_000)
    expect(all[0]?.startProgression).toBeCloseTo(0.1)
    expect(all[0]?.endProgression).toBeCloseTo(0.3)
  })

  it('does not credit a book left open overnight', () => {
    // The reader stopped turning pages and went to bed. Counting the whole
    // stretch would claim eight hours of reading nobody did.
    const sessions = new ReadingSessionRepository(db)
    const t0 = 1_700_000_000_000
    sessions.record('b1', t0, 0.1)
    sessions.record('b1', t0 + 60_000, 0.2)
    sessions.record('b1', t0 + 9 * 3_600_000, 0.21)

    const all = sessions.forBook('b1')
    expect(all).toHaveLength(2)
    expect(all[0]?.endedAt).toBe(t0 + 60_000)
    expect(all[1]?.startedAt).toBe(t0 + 9 * 3_600_000)
  })

  it('holds back the sitting still in progress', () => {
    const sessions = new ReadingSessionRepository(db)
    const now = 1_700_000_000_000
    sessions.record('b1', now - 30_000, 0.1)
    sessions.record('b1', now - 10_000, 0.2)
    expect(sessions.pendingUpload(['b1'], now)).toHaveLength(0)

    const later = now + IDLE_GAP_MS + 1000
    const pending = sessions.pendingUpload(['b1'], later)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.endProgression).toBeCloseTo(0.2)
  })

  it('ignores a book that was opened and shut again', () => {
    const sessions = new ReadingSessionRepository(db)
    const t0 = 1_700_000_000_000
    sessions.record('b1', t0, 0.1)
    expect(sessions.pendingUpload(['b1'], t0 + IDLE_GAP_MS + 1000)).toHaveLength(0)
  })

  it('sends a stretch to a server only once', () => {
    const sessions = new ReadingSessionRepository(db)
    const t0 = 1_700_000_000_000
    sessions.record('b1', t0, 0.1)
    sessions.record('b1', t0 + 60_000, 0.2)
    const later = t0 + 2 * IDLE_GAP_MS
    const pending = sessions.pendingUpload(['b1'], later)
    expect(pending).toHaveLength(1)
    sessions.markUploaded(pending.map((s) => s.id))
    expect(sessions.pendingUpload(['b1'], later)).toHaveLength(0)
  })
})
