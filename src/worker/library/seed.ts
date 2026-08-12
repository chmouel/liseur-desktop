import type { DatabaseSync } from 'node:sqlite'
import { generateFakeLibrary } from './fake-dataset'
import { BookRepository } from './book-repository'

/**
 * Development seed. Real EPUB ingestion arrives in Milestone 3; until then a
 * fresh database would leave the library empty and untestable. Seeding uses
 * the deterministic fake dataset and only ever runs on an empty database
 * when explicitly enabled (main enables it for unpackaged builds).
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
