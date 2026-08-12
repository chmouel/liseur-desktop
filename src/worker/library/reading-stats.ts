import type { DatabaseSync } from 'node:sqlite'
import type { ReadingStats, ReadingStatsBook, ReadingStatsDay } from '../../shared/ipc/protocol'

/**
 * Turns recorded reading stretches into the numbers the statistics screen
 * shows. Everything here works on the local database alone, so the screen
 * has something true to show before any server is asked, and keeps showing
 * it when no server is configured at all.
 *
 * The arithmetic is separated from the queries so the day arithmetic, which
 * is where mistakes hide, can be tested without a database.
 */

/** Days shown in the bar chart, matching the phone's "This past week". */
export const RECENT_DAYS = 7

export interface StatsSession {
  bookId: string
  startedAt: number
  endedAt: number
}

export interface StatsBook {
  id: string
  title: string
  author?: string | undefined
  finished: boolean
  progression?: number | undefined
}

/** Local calendar day of a moment, as YYYY-MM-DD. */
export function dayKey(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** Midnight starting the local day that contains `at`. */
function startOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Splits a stretch across the local days it covers, so a session running
 * past midnight is counted on both days rather than landing wholly on the
 * one it started in. The server splits the same way, so the local figures
 * and the server's agree.
 */
export function splitByDay(session: StatsSession): Array<{ day: string; ms: number }> {
  const out: Array<{ day: string; ms: number }> = []
  let cursor = session.startedAt
  // A clock change can make a day shorter or longer; walking midnights
  // rather than adding 24 hours keeps the buckets honest either way.
  while (cursor < session.endedAt) {
    const nextMidnight = startOfDay(cursor) + 24 * 60 * 60 * 1000
    const dayEnd = Math.min(session.endedAt, startOfDay(nextMidnight))
    out.push({ day: dayKey(cursor), ms: dayEnd - cursor })
    cursor = dayEnd
  }
  if (out.length === 0) out.push({ day: dayKey(session.startedAt), ms: 0 })
  return out
}

/**
 * Days read in a row, counting back from today. Yesterday still counts as
 * the end of a streak: someone who has not opened a book yet this morning
 * has not broken anything.
 */
export function streakDays(days: Set<string>, now: number): number {
  if (days.size === 0) return 0
  let cursor = startOfDay(now)
  if (!days.has(dayKey(cursor))) {
    cursor = startOfDay(cursor - 12 * 60 * 60 * 1000)
    if (!days.has(dayKey(cursor))) return 0
  }
  let streak = 0
  while (days.has(dayKey(cursor))) {
    streak += 1
    cursor = startOfDay(cursor - 12 * 60 * 60 * 1000)
  }
  return streak
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function computeReadingStats(
  sessions: StatsSession[],
  books: StatsBook[],
  now = Date.now(),
): ReadingStats {
  const byBook = new Map<string, { ms: number; sittings: number; lastReadAt: number }>()
  const msByDay = new Map<string, number>()
  let totalMs = 0

  for (const session of sessions) {
    const ms = Math.max(0, session.endedAt - session.startedAt)
    totalMs += ms
    const seen = byBook.get(session.bookId) ?? { ms: 0, sittings: 0, lastReadAt: 0 }
    seen.ms += ms
    seen.sittings += 1
    seen.lastReadAt = Math.max(seen.lastReadAt, session.endedAt)
    byBook.set(session.bookId, seen)
    for (const slice of splitByDay(session)) {
      msByDay.set(slice.day, (msByDay.get(slice.day) ?? 0) + slice.ms)
    }
  }

  const week: ReadingStatsDay[] = []
  const today = startOfDay(now)
  for (let i = RECENT_DAYS - 1; i >= 0; i -= 1) {
    // Stepping the date field rather than subtracting 24 hours keeps the
    // week right across a clock change.
    const dayStart = startOfDay(new Date(today).setDate(new Date(today).getDate() - i))
    const key = dayKey(dayStart)
    week.push({
      date: key,
      weekday: WEEKDAYS[new Date(dayStart).getDay()] ?? '',
      ms: msByDay.get(key) ?? 0,
      today: i === 0,
    })
  }

  const titles = new Map(books.map((book) => [book.id, book]))
  const perBook: ReadingStatsBook[] = [...byBook.entries()]
    .map(([bookId, seen]) => {
      const book = titles.get(bookId)
      return {
        bookId,
        title: book?.title ?? 'Unknown book',
        ...(book?.author ? { author: book.author } : {}),
        ms: seen.ms,
        sittings: seen.sittings,
        lastReadAt: seen.lastReadAt,
        finished: book?.finished ?? false,
        ...(book?.progression !== undefined ? { progression: book.progression } : {}),
      }
    })
    .sort((a, b) => b.ms - a.ms)

  return {
    totalMs,
    sittings: sessions.length,
    booksReadFrom: byBook.size,
    booksFinished: perBook.filter((book) => book.finished).length,
    streakDays: streakDays(new Set(msByDay.keys()), now),
    week,
    books: perBook,
    source: 'local',
  }
}

/** What a sync server can add to the figures computed above. */
export interface ServerReadingFigures {
  summary: { rangeDays: number; totalMs: number; sessions: number; streakDays: number } | null
  /** Milliseconds per YYYY-MM-DD, in the server's timezone for this reader. */
  calendar: Map<string, number> | null
  /** Lifetime totals keyed by *local* book id. */
  books: Map<string, { sessions: number; totalMs: number; lastReadAt?: number }> | null
}

/**
 * Folds the server's figures into this machine's.
 *
 * The server counts the same reading, seen from every device, so where it
 * answers it wins outright; adding the two would count this machine twice.
 * Where it says nothing — offline, no statistics token, a book it has never
 * been told about — the local figure stands rather than being blanked.
 */
export function mergeServerStats(
  local: ReadingStats,
  library: StatsBook[],
  server: ServerReadingFigures,
): ReadingStats {
  const metadata = new Map(library.map((book) => [book.id, book]))
  const byBook = new Map(local.books.map((book) => [book.bookId, book]))

  if (server.books) {
    for (const [bookId, insight] of server.books) {
      const book = metadata.get(bookId)
      if (!book) continue
      const existing = byBook.get(bookId)
      const lastReadAt = insight.lastReadAt ?? existing?.lastReadAt
      // A book the server knows but has no reading for is not worth a row.
      if (lastReadAt === undefined) continue
      if (insight.totalMs <= 0 && !existing) continue
      byBook.set(bookId, {
        bookId,
        title: book.title,
        ...(book.author ? { author: book.author } : {}),
        ms: Math.max(insight.totalMs, 0),
        sittings: insight.sessions || (existing?.sittings ?? 0),
        lastReadAt,
        finished: book.finished,
        ...(book.progression !== undefined ? { progression: book.progression } : {}),
      })
    }
  }

  const books = [...byBook.values()].sort((a, b) => b.ms - a.ms || a.title.localeCompare(b.title))

  const week = server.calendar
    ? local.week.map((day) => ({ ...day, ms: server.calendar?.get(day.date) ?? 0 }))
    : local.week

  const summary = server.summary
  return {
    totalMs: summary ? summary.totalMs : books.reduce((sum, book) => sum + book.ms, 0),
    sittings: summary ? summary.sessions : local.sittings,
    booksReadFrom: books.length,
    booksFinished: books.filter((book) => book.finished).length,
    streakDays: summary ? summary.streakDays : local.streakDays,
    week,
    books,
    source: summary ? 'server' : local.source,
    ...(summary ? { rangeDays: summary.rangeDays } : {}),
  }
}

/** Reads what the arithmetic above needs, and nothing else. */
export class ReadingStatsRepository {
  constructor(private readonly db: DatabaseSync) {}

  stats(now = Date.now()): ReadingStats {
    const sessions = this.db
      .prepare(
        `SELECT book_id, started_at, ended_at FROM reading_sessions
          WHERE ended_at > started_at ORDER BY started_at`,
      )
      .all() as unknown as Array<{ book_id: string; started_at: number; ended_at: number }>

    return computeReadingStats(
      sessions.map((row) => ({
        bookId: row.book_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      })),
      this.library(),
      now,
    )
  }

  /**
   * Title, author and progress for every book, needed to give a server's
   * per-book figures a name: the server knows a work id and minutes, and
   * nothing a reader would recognise.
   */
  library(): StatsBook[] {
    const books = this.db
      .prepare(
        `SELECT b.id, b.title, b.authors, b.finished, p.progression
           FROM books b LEFT JOIN reading_progress p ON p.book_id = b.id`,
      )
      .all() as unknown as Array<{
      id: string
      title: string
      authors: string
      finished: number
      progression: number | null
    }>

    return books.map((row) => ({
      id: row.id,
      title: row.title,
      author: firstAuthor(row.authors),
      finished: row.finished === 1,
      progression: row.progression ?? undefined,
    }))
  }
}

function firstAuthor(authors: string): string | undefined {
  try {
    const parsed = JSON.parse(authors) as unknown
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0]
  } catch {
    // A book with unreadable authors still has reading worth counting.
  }
  return undefined
}
