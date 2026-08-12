import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * SQLite database owned by the worker process.
 *
 * Uses Node's built-in `node:sqlite` (no native dependency to rebuild
 * against Electron). All access is synchronous — that is safe here because
 * the worker is a separate process: a query can never block the renderer or
 * delay startup. Main and the renderer must never see this module.
 */

export interface Migration {
  /** Monotonic schema version; applied in ascending order. */
  version: number
  name: string
  up: (db: DatabaseSync) => void
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // WAL allows reads to proceed alongside the (single) writer; foreign_keys
  // is off by default in SQLite and must be enabled per connection.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  // Without this, a momentarily locked database (WAL checkpoint, or a second
  // connection mid-write) fails the query instead of waiting — a book would
  // simply refuse to open. Blocking here is safe: this is the worker
  // process, so it can never stall the renderer.
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/**
 * Applies pending migrations in order, each inside its own transaction so a
 * failed migration leaves the database at the previous version. Schema
 * version is tracked with SQLite's built-in `user_version` pragma.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  const current = readUserVersion(db)
  for (const migration of migrations) {
    if (migration.version <= current) continue
    const expected = readUserVersion(db) + 1
    if (migration.version !== expected) {
      throw new Error(`migration gap: expected version ${expected}, got ${migration.version}`)
    }
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${migration.version} (${migration.name}) failed`, {
        cause: err,
      })
    }
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}
