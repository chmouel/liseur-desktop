import type { Migration } from './database'

/**
 * Schema migrations, applied in order by `migrate()`. Never edit an existing
 * migration once shipped — add a new one with the next version number.
 *
 * v1: folders (M3 will point scans at these), books, and reading_progress.
 * Locators and author lists are stored as JSON text; flags as 0/1 integers;
 * timestamps as Unix milliseconds.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'library schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE folders (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          added_at INTEGER NOT NULL
        );

        CREATE TABLE books (
          id TEXT PRIMARY KEY,
          folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          authors TEXT NOT NULL DEFAULT '[]',
          local_path TEXT,
          remote_id TEXT,
          cover_id TEXT,
          finished INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          downloaded INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL,
          last_opened_at INTEGER
        );

        CREATE TABLE reading_progress (
          book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
          locator TEXT NOT NULL,
          progression REAL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX idx_books_archived ON books(archived);
        CREATE INDEX idx_books_last_opened ON books(last_opened_at);
        CREATE INDEX idx_books_added ON books(added_at);
        CREATE INDEX idx_progress_updated ON reading_progress(updated_at);
      `)
    },
  },
  {
    version: 2,
    name: 'epub ingestion fields',
    up: (db) => {
      // Provenance for ingested files: content hash and dc:identifier power
      // duplicate detection; mtime+size let rescans skip unchanged files.
      db.exec(`
        ALTER TABLE books ADD COLUMN file_hash TEXT;
        ALTER TABLE books ADD COLUMN epub_identifier TEXT;
        ALTER TABLE books ADD COLUMN file_mtime INTEGER;
        ALTER TABLE books ADD COLUMN file_size INTEGER;
        CREATE INDEX idx_books_file_hash ON books(file_hash);
      `)
    },
  },
  {
    version: 3,
    name: 'annotations',
    up: (db) => {
      // Highlights and bookmarks. Locators are JSON (Readium-compatible with
      // text context + cssSelector for typography-stable re-anchoring).
      db.exec(`
        CREATE TABLE annotations (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('highlight', 'bookmark')),
          color TEXT,
          note TEXT,
          locator TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_annotations_book ON annotations(book_id);
      `)
    },
  },
  {
    version: 4,
    name: 'remote servers and sync',
    up: (db) => {
      // Server CONFIG only — credentials never touch SQLite (they live in
      // the OS-keychain-backed store in main, see src/main/secrets.ts).
      // sync_queue is the persisted, coalesced progress-push queue (one row
      // per book, latest wins); sync_conflicts preserves both-sided changes
      // for the catch-up UI.
      db.exec(`
        CREATE TABLE remote_servers (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('komga', 'calibre-web', 'liseur-sync')),
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          username TEXT,
          added_at INTEGER NOT NULL,
          last_sync_at INTEGER
        );

        ALTER TABLE books ADD COLUMN server_id TEXT REFERENCES remote_servers(id) ON DELETE SET NULL;
        CREATE INDEX idx_books_remote ON books(server_id, remote_id);

        CREATE TABLE sync_queue (
          book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
          locator TEXT NOT NULL,
          progression REAL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE sync_conflicts (
          book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
          local_locator TEXT NOT NULL,
          local_progression REAL,
          local_updated_at INTEGER NOT NULL,
          remote_locator TEXT NOT NULL,
          remote_progression REAL,
          remote_updated_at INTEGER NOT NULL,
          detected_at INTEGER NOT NULL
        );
      `)
    },
  },
  {
    version: 5,
    name: 'sync hardening',
    up: (db) => {
      // - Catalog-provided URLs stay with the book (calibre-web OPDS hrefs
      //   aren't reconstructable later).
      // - remote_servers.cursor: per-server sync cursor (liseur-sync
      //   high_water).
      // - server_book_links: many-to-many book↔server mappings, so a local
      //   book can sync progress to liseur-sync regardless of its catalog
      //   origin.
      db.exec(`
        ALTER TABLE books ADD COLUMN download_url TEXT;
        ALTER TABLE books ADD COLUMN cover_url TEXT;
        ALTER TABLE remote_servers ADD COLUMN cursor TEXT;

        CREATE TABLE server_book_links (
          server_id TEXT NOT NULL REFERENCES remote_servers(id) ON DELETE CASCADE,
          book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          remote_id TEXT NOT NULL,
          PRIMARY KEY (server_id, book_id)
        );
        CREATE UNIQUE INDEX idx_links_remote ON server_book_links(server_id, remote_id);
      `)
    },
  },
  {
    version: 6,
    name: 'per-target sync state',
    up: (db) => {
      // sync_acks: which (book, server) targets have durably received which
      // queued position version — multi-target delivery without loss.
      // sync_conflicts becomes target-specific; old rows are dropped
      // (conflicts are unresolved moments by definition — they re-detect at
      // the next sync).
      db.exec(`
        CREATE TABLE sync_acks (
          book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          server_id TEXT NOT NULL REFERENCES remote_servers(id) ON DELETE CASCADE,
          acked_updated_at INTEGER NOT NULL,
          PRIMARY KEY (book_id, server_id)
        );

        -- Conflicts become target-specific. Pre-v6 rows are preserved by
        -- deriving the target from the book's catalog origin (the only kind
        -- of conflict pre-v6 could record). Unmigratable rows (book lost its
        -- server) are captured FIRST so their queue rows can be dropped with
        -- them — otherwise they'd auto-push a conflicted position at startup.
        CREATE TEMP TABLE dropped_conflicts AS
          SELECT c.book_id FROM sync_conflicts c
          JOIN books b ON b.id = c.book_id
          WHERE b.server_id IS NULL OR b.remote_id IS NULL;

        CREATE TABLE sync_conflicts_new (
          book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          server_id TEXT NOT NULL REFERENCES remote_servers(id) ON DELETE CASCADE,
          remote_id TEXT NOT NULL,
          local_locator TEXT NOT NULL,
          local_progression REAL,
          local_updated_at INTEGER NOT NULL,
          remote_locator TEXT NOT NULL,
          remote_progression REAL,
          remote_updated_at INTEGER NOT NULL,
          detected_at INTEGER NOT NULL,
          PRIMARY KEY (book_id, server_id)
        );
        INSERT INTO sync_conflicts_new
          (book_id, server_id, remote_id, local_locator, local_progression, local_updated_at,
           remote_locator, remote_progression, remote_updated_at, detected_at)
          SELECT c.book_id, b.server_id, b.remote_id, c.local_locator, c.local_progression,
                 c.local_updated_at, c.remote_locator, c.remote_progression, c.remote_updated_at,
                 c.detected_at
          FROM sync_conflicts c
          JOIN books b ON b.id = c.book_id
          WHERE b.server_id IS NOT NULL AND b.remote_id IS NOT NULL;
        DROP TABLE sync_conflicts;
        ALTER TABLE sync_conflicts_new RENAME TO sync_conflicts;
        DELETE FROM sync_queue WHERE book_id IN (SELECT book_id FROM dropped_conflicts);
        DROP TABLE dropped_conflicts;
      `)
    },
  },
  {
    version: 7,
    name: 'undate positions from the future',
    up: (db) => {
      // A server dated some positions later than they could possibly have
      // been read: a device with a fast clock, or a server in the wrong
      // timezone. Such a book outranks everything read since, so it sat on
      // the Continue Reading banner and at the top of Recent, and would
      // have kept its place for as long as its date stayed ahead.
      //
      // A position from a server can be no newer than the last time we
      // spoke to that server, which is the honest bound to pull it back to.
      // For anything else, now.
      const now = Date.now()
      db.prepare(
        `UPDATE reading_progress SET updated_at = MIN(?, COALESCE(
           (SELECT s.last_sync_at FROM books b
              LEFT JOIN remote_servers s ON s.id = b.server_id
             WHERE b.id = reading_progress.book_id), ?))
         WHERE updated_at > ?`,
      ).run(now, now, now)
      db.prepare(
        `UPDATE books SET last_opened_at = MIN(?, COALESCE(
           (SELECT s.last_sync_at FROM remote_servers s WHERE s.id = books.server_id), ?))
         WHERE last_opened_at > ?`,
      ).run(now, now, now)
    },
  },
]
