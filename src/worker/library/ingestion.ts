import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Book } from '../../shared/domain/types'
import { EpubFile, coverExtension, titleFromFilename, type EpubCover } from '../epub/epub'
import { BookRepository, type IngestExtras } from './book-repository'
import { storeCoverBytes } from './cover-cache'

/**
 * EPUB ingestion and folder scanning.
 *
 * Everything here is async and yields between books (`setImmediate`), so a
 * large scan interleaves with library queries instead of blocking them —
 * this is what "progressive background scanning" means in practice. Newly
 * added books are reported one at a time via `onBookAdded`, never as a
 * full-list resend.
 *
 * Duplicate rule: same file content (sha256) → skipped; same OPF
 * dc:identifier → skipped. Missing files are never deleted during rescans —
 * a removed file must not take reading progress with it.
 */

export type SkipReason = 'unchanged' | 'duplicate-hash' | 'duplicate-identifier' | 'invalid'

export type IngestOutcome =
  { status: 'added'; book: Book } | { status: 'skipped'; reason: SkipReason }

export interface ScanStats {
  added: number
  skipped: number
  failed: number
}

export interface IngestionOptions {
  dataDir: string
  onBookAdded?: (book: Book) => void
  log?: (message: string) => void
}

export class IngestionService {
  private readonly repository: BookRepository
  private readonly dataDir: string
  private readonly onBookAdded: (book: Book) => void
  private readonly log: (message: string) => void

  constructor(db: DatabaseSync, options: IngestionOptions) {
    this.repository = new BookRepository(db)
    this.dataDir = options.dataDir
    this.onBookAdded = options.onBookAdded ?? (() => {})
    this.log = options.log ?? (() => {})
  }

  /** Adds a folder to the library (idempotent) and scans it. */
  async addFolder(path: string): Promise<ScanStats> {
    if (!this.repository.hasFolder(path)) {
      const id = createHash('sha256').update(path).digest('hex').slice(0, 16)
      this.repository.addFolder({ id, path, addedAt: Date.now() })
    }
    return this.scanFolder(path)
  }

  /** Rescans every registered folder (used at startup, asynchronously). */
  async rescanAll(): Promise<void> {
    for (const folder of this.repository.folders()) {
      const stats = await this.scanFolder(folder.path)
      if (stats.added > 0) this.log(`rescan: ${folder.path}: ${stats.added} new book(s)`)
    }
  }

  /** Scans one folder recursively for EPUB files. */
  async scanFolder(path: string): Promise<ScanStats> {
    const stats: ScanStats = { added: 0, skipped: 0, failed: 0 }
    let files: string[]
    try {
      files = await listEpubFiles(path)
    } catch {
      this.log(`scan: cannot read folder ${path}`)
      return { ...stats, failed: 1 }
    }
    for (const file of files) {
      const outcome = await this.ingestFile(file)
      if (outcome.status === 'added') stats.added++
      else if (outcome.status === 'skipped' && outcome.reason === 'invalid') stats.failed++
      else stats.skipped++
      await yieldToEventLoop()
    }
    return stats
  }

  /** Ingests a single EPUB file. */
  async ingestFile(path: string): Promise<IngestOutcome> {
    let data: Buffer
    let fileStat: { mtimeMs: number; size: number }
    try {
      fileStat = await stat(path)
      data = await readFile(path)
    } catch {
      return { status: 'skipped', reason: 'invalid' }
    }

    // Fast path for rescans: stat-only skip, no read or hash of a file we
    // already ingested unchanged.
    const fileMtime = Math.round(fileStat.mtimeMs)
    if (this.repository.isUnchanged(path, fileMtime, fileStat.size)) {
      return { status: 'skipped', reason: 'unchanged' }
    }

    const fileHash = createHash('sha256').update(data).digest('hex')
    if (this.repository.findIdByHash(fileHash)) {
      return { status: 'skipped', reason: 'duplicate-hash' }
    }

    let epub: EpubFile
    let metadata: ReturnType<EpubFile['metadata']>
    try {
      epub = new EpubFile(data)
      metadata = epub.metadata()
    } catch (err) {
      this.log(`ingest: ${path}: not a readable EPUB (${(err as Error).message})`)
      return { status: 'skipped', reason: 'invalid' }
    }

    if (metadata.identifier && this.repository.findIdByIdentifier(metadata.identifier)) {
      return { status: 'skipped', reason: 'duplicate-identifier' }
    }

    const coverId = metadata.cover ? this.cacheCover(epub, metadata.cover, fileHash) : undefined

    const book: Book = {
      id: `epub-${fileHash.slice(0, 16)}`,
      title: metadata.title ?? titleFromFilename(path),
      authors: metadata.authors,
      localPath: path,
      finished: false,
      archived: false,
      downloaded: true, // a local file is by definition on disk
      addedAt: Date.now(),
    }
    if (coverId) book.coverId = coverId

    this.repository.insertBooks([book], () => {
      const extras: IngestExtras = {
        fileHash,
        fileMtime,
        fileSize: fileStat.size,
      }
      if (metadata.identifier) extras.epubIdentifier = metadata.identifier
      return extras
    })
    this.onBookAdded(book)
    return { status: 'added', book }
  }

  /**
   * Stores the cover image in the cache, deduplicated by content hash — the
   * same image shared by a series costs one file. The coverId (hash +
   * extension) is what the `liseur-cover:` protocol serves later.
   */
  private cacheCover(epub: EpubFile, cover: EpubCover, fileHash: string): string | undefined {
    try {
      const bytes = epub.readCover(cover)
      if (!bytes) return undefined
      return storeCoverBytes(this.dataDir, bytes, coverExtension(cover.mediaType, cover.entryPath))
    } catch (err) {
      this.log(
        `ingest: cover extraction failed (${fileHash.slice(0, 8)}): ${(err as Error).message}`,
      )
      return undefined
    }
  }
}

async function listEpubFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listEpubFiles(full)))
    else if (extname(entry.name).toLowerCase() === '.epub') out.push(full)
  }
  return out
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
