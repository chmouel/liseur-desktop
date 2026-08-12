import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { SearchResult } from '../../shared/domain/types'
import { EpubFile } from '../epub/epub'
import { scanXml } from '../epub/xml'
import { BookRepository } from './book-repository'

/**
 * Full-book search, streaming. Spine items are read straight from the EPUB
 * (no extraction needed), text-extracted via the XML scanner, matched
 * case-insensitively on whitespace-normalized text, and reported per item
 * so results stream in as the scan proceeds. The process yields between
 * items so library queries interleave.
 *
 * The renderer re-anchors hits by quote (`before`/`match`/`after`), so
 * results stay valid across typography changes.
 */

/** Safety bound: a search never returns more than this many matches. */
export const MAX_SEARCH_RESULTS = 500

/** Normalizes whitespace exactly like the renderer's anchoring does. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Visible text of an XHTML spine item (script/style content excluded). */
export function extractText(xhtml: string): string {
  const chunks: string[] = []
  let skipDepth = 0
  scanXml(xhtml, {
    onStart: (el) => {
      if (el.localName === 'script' || el.localName === 'style') skipDepth++
    },
    onEnd: (_name, localName) => {
      if ((localName === 'script' || localName === 'style') && skipDepth > 0) skipDepth--
    },
    onText: (text) => {
      if (skipDepth === 0) chunks.push(text)
    },
  })
  return normalizeText(chunks.join(' '))
}

/** All case-insensitive matches of `query` in `text`, with context. */
export function findMatches(text: string, query: string, context = 40): SearchResult[] {
  const needle = normalizeText(query).toLowerCase()
  if (!needle) return []
  const haystack = text.toLowerCase()
  const out: SearchResult[] = []
  let from = 0
  while (out.length < MAX_SEARCH_RESULTS) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    out.push({
      href: '', // filled by the caller
      before: text.slice(Math.max(0, at - context), at).trimStart(),
      match: text.slice(at, at + needle.length),
      after: text.slice(at + needle.length, at + needle.length + context).trimEnd(),
    })
    from = at + needle.length
  }
  return out
}

export class BookSearchService {
  private readonly repository: BookRepository

  constructor(db: DatabaseSync) {
    this.repository = new BookRepository(db)
  }

  /**
   * Searches a book; calls `onBatch(results, done)` per spine item that
   * produced matches, and once at the end with `done: true`. A new search
   * supersedes a running one via `shouldContinue` — cancelled scans stop
   * work immediately (no final batch).
   */
  async search(
    bookId: string,
    query: string,
    onBatch: (results: SearchResult[], done: boolean) => void,
    shouldContinue: () => boolean = () => true,
  ): Promise<void> {
    const book = this.repository.getById(bookId)
    if (!book?.localPath) {
      onBatch([], true)
      return
    }
    const epub = new EpubFile(await readFile(book.localPath))
    const spine = epub.spine()

    let total = 0
    for (const item of spine) {
      if (!shouldContinue()) return // superseded by a newer search
      if (!item.mediaType.includes('html')) continue
      const xhtml = epub.zip.readText(item.href)
      if (!xhtml) continue
      const text = extractText(xhtml)
      const matches = findMatches(text, query)
      for (const m of matches) m.href = item.href
      const room = MAX_SEARCH_RESULTS - total
      if (matches.length > 0) {
        const batch = matches.slice(0, room)
        total += batch.length
        onBatch(batch, false)
      }
      if (total >= MAX_SEARCH_RESULTS) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (shouldContinue()) onBatch([], true)
  }
}
