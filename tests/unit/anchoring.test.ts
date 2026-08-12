import { describe, expect, it } from 'vitest'
import {
  extractQuote,
  findQuote,
  normalizeText,
  normalizeWithMap,
} from '../../src/renderer/reader/anchoring'

describe('normalizeWithMap', () => {
  it('collapses whitespace and maps back to raw offsets', () => {
    const { text, map } = normalizeWithMap('a  b\n\nc')
    expect(text).toBe('a b c')
    // 'b' sits at raw index 3
    expect(map[2]).toBe(3)
  })

  it('handles leading/trailing whitespace', () => {
    const { text } = normalizeWithMap('  hello  ')
    expect(text).toBe('hello')
  })
})

describe('extractQuote', () => {
  it('extracts highlight with bounded context', () => {
    const text = 'a'.repeat(100)
    const quote = extractQuote(text, 50, 55)
    expect(quote.highlight).toBe('aaaaa')
    expect(quote.before).toHaveLength(40)
    expect(quote.after).toHaveLength(40)
  })
})

describe('findQuote', () => {
  const raw = 'The quick  brown\nfox jumps. The quick brown fox sleeps.'

  it('finds a quote across raw whitespace differences', () => {
    // stored quote has normalized whitespace; raw text has doubles/newline
    const hit = findQuote(raw, { before: '', highlight: 'quick brown fox jumps', after: '' })
    expect(hit).not.toBeNull()
    expect(raw.slice(hit!.start, hit!.end)).toBe('quick  brown\nfox jumps')
  })

  it('is case-insensitive', () => {
    const hit = findQuote(raw, { before: '', highlight: 'QUICK BROWN FOX JUMPS', after: '' })
    expect(hit).not.toBeNull()
  })

  it('disambiguates repeats with context', () => {
    const hit = findQuote(raw, {
      before: 'jumps.',
      highlight: 'The quick brown fox',
      after: 'sleeps.',
    })
    expect(hit).not.toBeNull()
    expect(hit!.start).toBeGreaterThan(20) // the second occurrence
  })

  it('falls back to the first bare match when context fails', () => {
    const hit = findQuote(raw, {
      before: 'nonexistent context',
      highlight: 'The quick brown fox',
      after: 'nothing',
    })
    expect(hit?.start).toBe(0)
  })

  it('returns null when absent', () => {
    expect(findQuote(raw, { before: '', highlight: 'zebra', after: '' })).toBeNull()
  })

  it('normalizeText matches the worker normalization', () => {
    expect(normalizeText('  a \n b\t\tc  ')).toBe('a b c')
  })
})
