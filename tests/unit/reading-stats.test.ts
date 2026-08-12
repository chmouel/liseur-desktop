import { describe, expect, it, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, migrate } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'
import {
  computeReadingStats,
  dayKey,
  mergeServerStats,
  splitByDay,
  streakDays,
  ReadingStatsRepository,
  RECENT_DAYS,
} from '../../src/worker/library/reading-stats'
import { readingDuration } from '../../src/renderer/stats/StatsScreen'

/** Local wall-clock moment, so the tests read the same in any timezone. */
function at(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

const MIN = 60_000

describe('splitByDay', () => {
  it('keeps a session inside one day when it does not cross midnight', () => {
    const slices = splitByDay({
      bookId: 'b1',
      startedAt: at(2024, 3, 5, 20, 0),
      endedAt: at(2024, 3, 5, 21, 30),
    })
    expect(slices).toEqual([{ day: '2024-03-05', ms: 90 * MIN }])
  })

  it('splits a session that runs past midnight across both days', () => {
    const slices = splitByDay({
      bookId: 'b1',
      startedAt: at(2024, 3, 5, 23, 30),
      endedAt: at(2024, 3, 6, 0, 45),
    })
    expect(slices).toEqual([
      { day: '2024-03-05', ms: 30 * MIN },
      { day: '2024-03-06', ms: 45 * MIN },
    ])
  })
})

describe('streakDays', () => {
  it('counts back from today', () => {
    const now = at(2024, 3, 5, 9, 0)
    const days = new Set(['2024-03-05', '2024-03-04', '2024-03-03'])
    expect(streakDays(days, now)).toBe(3)
  })

  it('still counts a streak that ended yesterday', () => {
    const now = at(2024, 3, 5, 9, 0)
    const days = new Set(['2024-03-04', '2024-03-03'])
    expect(streakDays(days, now)).toBe(2)
  })

  it('is broken once a whole day is missed', () => {
    const now = at(2024, 3, 5, 9, 0)
    const days = new Set(['2024-03-03', '2024-03-02'])
    expect(streakDays(days, now)).toBe(0)
  })

  it('is zero with nothing recorded', () => {
    expect(streakDays(new Set(), at(2024, 3, 5))).toBe(0)
  })
})

describe('computeReadingStats', () => {
  const books = [
    { id: 'b1', title: 'Dune', author: 'Herbert', finished: true, progression: 1 },
    { id: 'b2', title: 'Solaris', author: 'Lem', finished: false, progression: 0.42 },
  ]

  it('adds up time, sittings and books, and ranks books by time', () => {
    const now = at(2024, 3, 5, 20, 0)
    const stats = computeReadingStats(
      [
        { bookId: 'b1', startedAt: at(2024, 3, 5, 9, 0), endedAt: at(2024, 3, 5, 9, 30) },
        { bookId: 'b2', startedAt: at(2024, 3, 5, 10, 0), endedAt: at(2024, 3, 5, 11, 0) },
        { bookId: 'b1', startedAt: at(2024, 3, 4, 10, 0), endedAt: at(2024, 3, 4, 10, 10) },
      ],
      books,
      now,
    )

    expect(stats.totalMs).toBe(100 * MIN)
    expect(stats.sittings).toBe(3)
    expect(stats.booksReadFrom).toBe(2)
    expect(stats.booksFinished).toBe(1)
    expect(stats.streakDays).toBe(2)
    expect(stats.source).toBe('local')
    expect(stats.books.map((b) => b.bookId)).toEqual(['b2', 'b1'])
    expect(stats.books[0]?.ms).toBe(60 * MIN)
    expect(stats.books[1]?.sittings).toBe(2)
  })

  it('gives the week seven days ending today, whatever was read', () => {
    const now = at(2024, 3, 5, 20, 0)
    const stats = computeReadingStats(
      [{ bookId: 'b1', startedAt: at(2024, 3, 3, 9, 0), endedAt: at(2024, 3, 3, 9, 20) }],
      books,
      now,
    )
    expect(stats.week).toHaveLength(RECENT_DAYS)
    expect(stats.week.at(-1)?.date).toBe('2024-03-05')
    expect(stats.week.at(-1)?.today).toBe(true)
    expect(stats.week.find((d) => d.date === '2024-03-03')?.ms).toBe(20 * MIN)
    expect(stats.week.find((d) => d.date === '2024-03-04')?.ms).toBe(0)
  })

  it('puts a midnight-crossing session on both days of the chart', () => {
    const now = at(2024, 3, 5, 20, 0)
    const stats = computeReadingStats(
      [{ bookId: 'b1', startedAt: at(2024, 3, 4, 23, 40), endedAt: at(2024, 3, 5, 0, 20) }],
      books,
      now,
    )
    expect(stats.week.find((d) => d.date === '2024-03-04')?.ms).toBe(20 * MIN)
    expect(stats.week.find((d) => d.date === '2024-03-05')?.ms).toBe(20 * MIN)
    // The stretch is still one sitting, and still counted once in the total.
    expect(stats.sittings).toBe(1)
    expect(stats.totalMs).toBe(40 * MIN)
  })

  it('reports nothing rather than failing on an empty library', () => {
    const stats = computeReadingStats([], [], at(2024, 3, 5))
    expect(stats.totalMs).toBe(0)
    expect(stats.sittings).toBe(0)
    expect(stats.streakDays).toBe(0)
    expect(stats.books).toEqual([])
    expect(stats.week).toHaveLength(RECENT_DAYS)
  })

  it('names a book it no longer has rather than dropping its time', () => {
    const stats = computeReadingStats(
      [{ bookId: 'gone', startedAt: at(2024, 3, 5, 9, 0), endedAt: at(2024, 3, 5, 9, 15) }],
      books,
      at(2024, 3, 5, 20, 0),
    )
    expect(stats.books[0]?.title).toBe('Unknown book')
    expect(stats.totalMs).toBe(15 * MIN)
  })
})

describe('dayKey', () => {
  it('pads month and day', () => {
    expect(dayKey(at(2024, 1, 2, 13, 0))).toBe('2024-01-02')
  })
})

describe('ReadingStatsRepository', () => {
  let db: DatabaseSync

  beforeEach(() => {
    db = openDatabase(':memory:')
    migrate(db, MIGRATIONS)
    db.prepare(
      `INSERT INTO books (id, title, authors, downloaded, finished, archived, added_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('b1', 'Dune', JSON.stringify(['Frank Herbert']), 1, 1, 0, 0)
  })

  it('reads sessions and books out of the database', () => {
    db.prepare(
      `INSERT INTO reading_sessions (id, book_id, started_at, ended_at) VALUES (?,?,?,?)`,
    ).run('s1', 'b1', at(2024, 3, 5, 9, 0), at(2024, 3, 5, 9, 30))

    const stats = new ReadingStatsRepository(db).stats(at(2024, 3, 5, 20, 0))
    expect(stats.totalMs).toBe(30 * MIN)
    expect(stats.books[0]).toMatchObject({
      bookId: 'b1',
      title: 'Dune',
      author: 'Frank Herbert',
      finished: true,
    })
  })

  it('ignores a stretch that never ended', () => {
    db.prepare(
      `INSERT INTO reading_sessions (id, book_id, started_at, ended_at) VALUES (?,?,?,?)`,
    ).run('s1', 'b1', at(2024, 3, 5, 9, 0), at(2024, 3, 5, 9, 0))

    expect(new ReadingStatsRepository(db).stats(at(2024, 3, 5, 20, 0)).sittings).toBe(0)
  })
})

describe('readingDuration', () => {
  it('writes durations the way the phone does', () => {
    expect(readingDuration(0)).toBe('None')
    expect(readingDuration(30_000)).toBe('Less than a minute')
    expect(readingDuration(5 * MIN)).toBe('5 min')
    expect(readingDuration(59 * MIN)).toBe('59 min')
    expect(readingDuration(60 * MIN)).toBe('1 hr')
    expect(readingDuration(80 * MIN)).toBe('1 h 20 min')
  })
})

describe('mergeServerStats', () => {
  const library = [
    { id: 'b1', title: 'Dune', author: 'Herbert', finished: false, progression: 0.5 },
    { id: 'b2', title: 'Solaris', author: 'Lem', finished: true, progression: 1 },
  ]
  const now = at(2024, 3, 5, 20, 0)
  const local = computeReadingStats(
    [{ bookId: 'b1', startedAt: at(2024, 3, 5, 9, 0), endedAt: at(2024, 3, 5, 9, 30) }],
    library,
    now,
  )

  it('takes the server total rather than adding it to the local one', () => {
    const merged = mergeServerStats(local, library, {
      summary: { rangeDays: 30, totalMs: 500 * MIN, sessions: 12, streakDays: 4 },
      calendar: null,
      books: null,
    })
    // Not 530: the server already counted this computer's half hour.
    expect(merged.totalMs).toBe(500 * MIN)
    expect(merged.sittings).toBe(12)
    expect(merged.streakDays).toBe(4)
    expect(merged.rangeDays).toBe(30)
    expect(merged.source).toBe('server')
  })

  it('keeps the local figures when the server has none', () => {
    const merged = mergeServerStats(local, library, {
      summary: null,
      calendar: null,
      books: null,
    })
    expect(merged.totalMs).toBe(30 * MIN)
    expect(merged.sittings).toBe(local.sittings)
    expect(merged.streakDays).toBe(local.streakDays)
    expect(merged.source).toBe('local')
    expect(merged.rangeDays).toBeUndefined()
  })

  it('replaces the week chart with the days the server counted', () => {
    const merged = mergeServerStats(local, library, {
      summary: null,
      calendar: new Map([
        ['2024-03-05', 45 * MIN],
        ['2024-03-02', 90 * MIN],
      ]),
      books: null,
    })
    expect(merged.week.find((d) => d.date === '2024-03-05')?.ms).toBe(45 * MIN)
    expect(merged.week.find((d) => d.date === '2024-03-02')?.ms).toBe(90 * MIN)
    // A day the server did not mention was not read on, anywhere.
    expect(merged.week.find((d) => d.date === '2024-03-04')?.ms).toBe(0)
    expect(merged.week).toHaveLength(RECENT_DAYS)
  })

  it('brings in a book read only on another device', () => {
    const merged = mergeServerStats(local, library, {
      summary: null,
      calendar: null,
      books: new Map([
        ['b1', { sessions: 5, totalMs: 200 * MIN, lastReadAt: now }],
        ['b2', { sessions: 3, totalMs: 120 * MIN, lastReadAt: now }],
      ]),
    })
    expect(merged.books.map((b) => b.bookId)).toEqual(['b1', 'b2'])
    expect(merged.books[0]?.ms).toBe(200 * MIN)
    expect(merged.books[0]?.sittings).toBe(5)
    // Solaris was never opened on this computer, so only the server has it.
    expect(merged.books[1]?.title).toBe('Solaris')
    expect(merged.booksReadFrom).toBe(2)
    expect(merged.booksFinished).toBe(1)
    // With no summary the total is the merged books, not the local sum.
    expect(merged.totalMs).toBe(320 * MIN)
  })

  it('leaves a book the server has never heard of alone', () => {
    const merged = mergeServerStats(local, library, {
      summary: null,
      calendar: null,
      books: new Map(),
    })
    expect(merged.books).toHaveLength(1)
    expect(merged.books[0]?.ms).toBe(30 * MIN)
  })

  it('ignores a server book that is no longer in this library', () => {
    const merged = mergeServerStats(local, library, {
      summary: null,
      calendar: null,
      books: new Map([['gone', { sessions: 2, totalMs: 60 * MIN, lastReadAt: now }]]),
    })
    expect(merged.books.map((b) => b.bookId)).toEqual(['b1'])
  })
})
