import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Book, OpenedBook } from '../../shared/domain/types'
import { EpubFile } from '../epub/epub'
import { AnnotationRepository } from './annotation-repository'
import { BookRepository } from './book-repository'

/** Untrusted-input extraction limits (zip-bomb guards, see zip.ts too). */
const MAX_EXTRACTED_ENTRIES = 10_000
const MAX_EXTRACTED_TOTAL_BYTES = 1024 * 1024 * 1024 // 1 GiB

/**
 * Opening a book for the reader.
 *
 * The EPUB is extracted once into `$LISEUR_DATA_DIR/extracted/<bookId>/` and
 * reused while the source file is unchanged (marker file with mtime+size).
 * The renderer then fetches chapters/resources straight from main's
 * `liseur-epub:` scheme — no per-resource IPC, no main-process EPUB parsing.
 * Everything here runs in the worker; a cold extraction never touches the
 * renderer or main.
 */

interface ExtractionMarker {
  mtime: number
  size: number
}

export class BookOpener {
  private readonly repository: BookRepository
  private readonly annotations: AnnotationRepository

  constructor(
    db: DatabaseSync,
    private readonly dataDir: string,
    /** M7: opening a not-yet-downloaded remote book downloads it first. */
    private readonly downloadIfRemote?: (bookId: string) => Promise<Book | null>,
  ) {
    this.repository = new BookRepository(db)
    this.annotations = new AnnotationRepository(db)
  }

  async open(bookId: string): Promise<OpenedBook> {
    let book0 = this.repository.getById(bookId)
    if (!book0) throw new Error(`unknown book ${bookId}`)
    if (!book0.localPath && book0.remoteId && book0.serverId && this.downloadIfRemote) {
      // Remote shell: fetch the file on demand, then proceed as local.
      book0 = (await this.downloadIfRemote(bookId)) ?? book0
    }
    if (!book0.localPath) throw new Error(`book "${book0.title}" is not downloaded`)

    // Stat the file now — ingestion-time metadata can be stale if the file
    // changed before a rescan, and the extraction cache must key off reality.
    const [data, fileStat] = await Promise.all([readFile(book0.localPath), stat(book0.localPath)])
    const epub = new EpubFile(data)
    this.ensureExtracted(bookId, epub, Math.round(fileStat.mtimeMs), fileStat.size)

    // Opening counts as "recently opened" immediately — the library should
    // reflect the current read without waiting for progress to be saved.
    const book = this.repository.touchOpened(bookId, Date.now())

    return {
      book,
      spine: epub.spine(),
      toc: epub.toc(),
      contentBaseUrl: `liseur-epub://book/${encodeURIComponent(bookId)}/`,
      annotations: this.annotations.list(bookId),
    }
  }

  /** Extracts the archive unless an up-to-date extraction already exists. */
  private ensureExtracted(bookId: string, epub: EpubFile, mtime: number, size: number): void {
    const dir = join(this.dataDir, 'extracted', bookId)
    const markerPath = join(dir, '.liseur.json')

    if (existsSync(markerPath)) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as ExtractionMarker
        if (marker.mtime === mtime && marker.size === size) return // cache hit
      } catch {
        // Corrupt marker: re-extract.
      }
    }

    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const names = epub.zip.entries()
    if (names.length > MAX_EXTRACTED_ENTRIES) {
      throw new Error(`archive has ${names.length} entries (limit ${MAX_EXTRACTED_ENTRIES})`)
    }
    let total = 0
    for (const name of names) {
      // Guard against pathological archives writing outside the directory.
      const normalized = name.replaceAll('\\', '/')
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) continue
      const content = epub.zip.read(name)
      if (!content) continue
      total += content.length
      if (total > MAX_EXTRACTED_TOTAL_BYTES) {
        rmSync(dir, { recursive: true, force: true })
        throw new Error('archive exceeds extraction size limit')
      }
      const target = join(dir, normalized)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, content)
    }
    writeFileSync(markerPath, JSON.stringify({ mtime, size } satisfies ExtractionMarker))
  }
}
