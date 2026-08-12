import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Reading sessions: how long a book was actually read, in stretches.
 *
 * Derived from the positions the reader already saves rather than from a
 * separate stream of start/stop events. Every page turn saves a position,
 * so the positions are the record of someone turning pages, and deriving
 * from them means a session can never be left open by a crash, a closed
 * lid, or a window that never sent its goodbye.
 *
 * A gap longer than IDLE_GAP_MS ends a stretch. Time spent staring at one
 * page for longer than that is not counted, which is the point: a book left
 * open overnight should not claim eight hours of reading.
 */

/** A pause longer than this ends the stretch rather than extending it. */
export const IDLE_GAP_MS = 5 * 60 * 1000

export interface ReadingSession {
  id: string
  bookId: string
  startedAt: number
  endedAt: number
  startProgression?: number | undefined
  endProgression?: number | undefined
}

interface SessionRow {
  id: string
  book_id: string
  started_at: number
  ended_at: number
  start_progression: number | null
  end_progression: number | null
}

function toSession(row: SessionRow): ReadingSession {
  return {
    id: row.id,
    bookId: row.book_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    startProgression: row.start_progression ?? undefined,
    endProgression: row.end_progression ?? undefined,
  }
}

export class ReadingSessionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly idleGapMs: number = IDLE_GAP_MS,
  ) {}

  /**
   * Records that the reader is at `progression` in this book right now.
   *
   * Extends the current stretch, or opens a new one when the last sighting
   * is too old to belong to the same sitting.
   */
  record(bookId: string, at: number, progression?: number): ReadingSession {
    const open = this.db
      .prepare(
        `SELECT id, book_id, started_at, ended_at, start_progression, end_progression
           FROM reading_sessions WHERE book_id = ? ORDER BY ended_at DESC LIMIT 1`,
      )
      .get(bookId) as SessionRow | undefined

    if (open && at >= open.ended_at && at - open.ended_at <= this.idleGapMs) {
      this.db
        .prepare('UPDATE reading_sessions SET ended_at = ?, end_progression = ? WHERE id = ?')
        .run(at, progression ?? open.end_progression, open.id)
      return {
        ...toSession(open),
        endedAt: at,
        endProgression: progression ?? toSession(open).endProgression,
      }
    }

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO reading_sessions
           (id, book_id, started_at, ended_at, start_progression, end_progression)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(id, bookId, at, at, progression ?? null, progression ?? null)
    return {
      id,
      bookId,
      startedAt: at,
      endedAt: at,
      startProgression: progression,
      endProgression: progression,
    }
  }

  /**
   * Stretches that are over and have never been sent to a server.
   *
   * A stretch counts as over once nothing has extended it for the idle gap,
   * so the sitting in progress is left alone until the reader stops. Only
   * stretches that lasted a moment are worth a server's time: opening a book
   * and closing it again is not reading.
   */
  pendingUpload(bookIds: string[], now = Date.now(), minDurationMs = 1000): ReadingSession[] {
    if (bookIds.length === 0) return []
    const placeholders = bookIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT id, book_id, started_at, ended_at, start_progression, end_progression
           FROM reading_sessions
          WHERE uploaded_at IS NULL
            AND book_id IN (${placeholders})
            AND ended_at <= ?
            AND ended_at - started_at >= ?
          ORDER BY ended_at
          LIMIT 500`,
      )
      .all(...bookIds, now - this.idleGapMs, minDurationMs) as unknown as SessionRow[]
    return rows.map(toSession)
  }

  markUploaded(ids: string[], at = Date.now()): void {
    if (ids.length === 0) return
    const stmt = this.db.prepare('UPDATE reading_sessions SET uploaded_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(at, id)
  }

  forBook(bookId: string): ReadingSession[] {
    const rows = this.db
      .prepare(
        `SELECT id, book_id, started_at, ended_at, start_progression, end_progression
           FROM reading_sessions WHERE book_id = ? ORDER BY started_at`,
      )
      .all(bookId) as unknown as SessionRow[]
    return rows.map(toSession)
  }
}
