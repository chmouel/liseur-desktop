import { describe, expect, it } from 'vitest'
import { generateFakeLibrary, FAKE_LIBRARY_SIZE } from '../../src/worker/library/fake-dataset'

describe('generateFakeLibrary', () => {
  it('generates the requested number of books', () => {
    expect(generateFakeLibrary()).toHaveLength(FAKE_LIBRARY_SIZE)
  })

  it('is deterministic across runs', () => {
    // Timestamps derive from Date.now(); compare only fields that must be
    // identical regardless of when the generator runs.
    const a = generateFakeLibrary()
    const b = generateFakeLibrary()
    const strip = (books: typeof a) =>
      books.map(({ addedAt: _a, lastOpenedAt: _l, progress, ...rest }) => ({
        ...rest,
        progress: progress && { ...progress, updatedAt: 0 },
      }))
    expect(strip(a)).toEqual(strip(b))
    // And within a single run, ordering of timestamps relative to `now` is stable.
    expect(a[0]!.title).toBe(b[0]!.title)
  })

  it('produces unique ids and populated fields', () => {
    const books = generateFakeLibrary()
    const ids = new Set(books.map((b) => b.id))
    expect(ids.size).toBe(books.length)
    for (const book of books) {
      expect(book.title.length).toBeGreaterThan(0)
      expect(book.authors.length).toBeGreaterThan(0)
      expect(book.addedAt).toBeGreaterThan(0)
    }
  })

  it('keeps progress within 0..1 and finished books complete', () => {
    for (const book of generateFakeLibrary()) {
      if (!book.progress) continue
      expect(book.progress.progression).toBeGreaterThan(0)
      expect(book.progress.progression).toBeLessThanOrEqual(1)
      if (book.finished) expect(book.progress.progression).toBe(1)
    }
  })
})
