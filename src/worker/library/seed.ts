import type { DatabaseSync } from 'node:sqlite'
import { generateFakeLibrary } from './fake-dataset'
import { BookRepository } from './book-repository'

/**
 * Perf-testing seed. Books arrive by real EPUB ingestion (M3); this exists
 * only to fill a library with enough entries to measure the grid,
 * virtualization and search against their budgets (see PERFORMANCE.md).
 *
 * It never runs unless LISEUR_SEED_FAKE_LIBRARY=1 is set, and never on a
 * database that already holds books — a fresh install must open onto an
 * empty library, not onto thousands of books that do not exist.
 */

export const SEED_LIBRARY_SIZE = 10_000

export function seedLibraryIfEmpty(db: DatabaseSync, size: number = SEED_LIBRARY_SIZE): boolean {
  const repository = new BookRepository(db)
  if (repository.count() > 0) return false

  // Seeded books belong to no folder — folders are real on-disk locations
  // (M3), and a fake path would get rescanned at every startup.
  repository.insertBooks(generateFakeLibrary(size))
  return true
}
