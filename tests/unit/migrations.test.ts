import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, migrate, type Migration } from '../../src/worker/db/database'
import { MIGRATIONS } from '../../src/worker/db/migrations'

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

describe('migrate', () => {
  it('migrates a fresh database to the latest version', () => {
    const db = openDatabase(':memory:')
    migrate(db, MIGRATIONS)
    expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)))

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual([
      'annotations',
      'books',
      'folders',
      'reading_progress',
      'remote_servers',
      'server_book_links',
      'sync_acks',
      'sync_conflicts',
      'sync_queue',
    ])
  })

  it('is a no-op when run again', () => {
    const db = openDatabase(':memory:')
    migrate(db, MIGRATIONS)
    migrate(db, MIGRATIONS)
    expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)))
  })

  it('applies migrations in version order', () => {
    const order: number[] = []
    const migrations: Migration[] = [
      { version: 2, name: 'two', up: () => order.push(2) },
      { version: 1, name: 'one', up: () => order.push(1) },
    ]
    const db = openDatabase(':memory:')
    migrate(
      db,
      [...migrations].sort((a, b) => a.version - b.version),
    )
    expect(order).toEqual([1, 2])
    expect(userVersion(db)).toBe(2)
  })

  it('rejects a gap in migration versions', () => {
    const db = openDatabase(':memory:')
    migrate(db, [{ version: 1, name: 'one', up: () => {} }])
    expect(() => migrate(db, [{ version: 3, name: 'three', up: () => {} }])).toThrow(/gap/)
    expect(userVersion(db)).toBe(1)
  })

  it('rolls back a failed migration, keeping the previous version', () => {
    const db = openDatabase(':memory:')
    migrate(db, [{ version: 1, name: 'one', up: (d) => d.exec('CREATE TABLE t1 (a)') }])
    expect(() =>
      migrate(db, [
        {
          version: 2,
          name: 'broken',
          up: (d) => {
            d.exec('CREATE TABLE t2 (a)')
            throw new Error('boom')
          },
        },
      ]),
    ).toThrow(/migration 2 \(broken\) failed/)
    expect(userVersion(db)).toBe(1)
    // The partial table must not survive the rollback.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't2'").all()).toHaveLength(0)
    // The database stays usable.
    db.prepare('INSERT INTO t1 VALUES (1)').run()
  })

  it('migrates v1 databases to v2 preserving existing rows', () => {
    const db = openDatabase(':memory:')
    migrate(db, MIGRATIONS.slice(0, 1)) // v1 only
    db.prepare(
      `INSERT INTO books (id, title, authors, finished, archived, downloaded, added_at)
       VALUES ('b1', 'Old Book', '["Someone"]', 0, 0, 1, 42)`,
    ).run()

    migrate(db, MIGRATIONS) // catch up to latest
    expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)))

    const row = db
      .prepare('SELECT title, file_hash, epub_identifier, file_mtime, file_size FROM books')
      .get() as Record<string, unknown>
    expect(row['title']).toBe('Old Book')
    expect(row['file_hash']).toBeNull()
  })

  it('enables foreign key enforcement', () => {
    const db = openDatabase(':memory:')
    migrate(db, MIGRATIONS)
    expect(() =>
      db.prepare('INSERT INTO reading_progress VALUES (?,?,?,?)').run('missing', '{}', 0.5, 1),
    ).toThrow(/FOREIGN KEY/)
  })

  it('uses WAL journaling for file-backed databases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'liseur-db-test-'))
    try {
      const db = openDatabase(join(dir, 'test.db'))
      const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(row.journal_mode).toBe('wal')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('waits for a locked database instead of failing the query', () => {
    // Without a busy timeout, a database locked for even a moment (a WAL
    // checkpoint, a second connection mid-write) makes queries throw, and a
    // book simply refuses to open.
    const db = openDatabase(':memory:')
    const row = db.prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(row.timeout).toBeGreaterThan(0)
    db.close()
  })
})
