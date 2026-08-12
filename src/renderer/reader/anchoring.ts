import type { Locator } from '../../shared/domain/types'

/**
 * Text anchoring for highlights, bookmarks and search jumps.
 *
 * Locators must survive typography changes, relayouts and restarts, so they
 * anchor on CONTENT, never geometry: a CSS selector for the containing
 * element plus a text quote with context (Readium `text` field).
 *
 * Text streams keep the RAW concatenated text (so DOM offsets are exact);
 * matching happens on a normalized copy with an index map back to raw
 * offsets. The worker's search (book-search.ts) normalizes the same way, so
 * its quotes re-anchor here reliably.
 */

export interface TextQuote {
  before: string
  highlight: string
  after: string
}

export const QUOTE_CONTEXT = 40

/** Mirrors the worker's search normalization (see book-search.ts). */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Normalizes whitespace like normalizeText but keeps a map from each
 * normalized character back to its raw index.
 */
export function normalizeWithMap(raw: string): { text: string; map: number[] } {
  const out: string[] = []
  const map: number[] = []
  let pendingSpace = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0
      continue
    }
    if (pendingSpace) {
      out.push(' ')
      map.push(i - 1) // the collapsed space belongs to the run's end
    }
    out.push(ch)
    map.push(i)
    pendingSpace = false
  }
  return { text: out.join(''), map }
}

export function extractQuote(text: string, start: number, end: number): TextQuote {
  return {
    before: text.slice(Math.max(0, start - QUOTE_CONTEXT), start).trimStart(),
    highlight: text.slice(start, end),
    after: text.slice(end, end + QUOTE_CONTEXT).trimEnd(),
  }
}

/**
 * Locates a quote in raw text (matching is case-insensitive on the
 * normalized form). Repeated matches are disambiguated with the before/after
 * context; otherwise the first bare-highlight match wins.
 * Returns RAW offsets.
 */
export function findQuote(raw: string, quote: TextQuote): { start: number; end: number } | null {
  const { text, map } = normalizeWithMap(raw)
  // The quote may carry raw whitespace (it can be built from raw text);
  // normalize both sides so matching is whitespace-insensitive.
  const needle = normalizeText(quote.highlight).toLowerCase()
  const beforeQ = normalizeText(quote.before).toLowerCase()
  const afterQ = normalizeText(quote.after).toLowerCase()
  if (!needle) return null
  const haystack = text.toLowerCase()

  let best: number | null = null
  let from = 0
  while (true) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    if (best === null) best = at
    const before = text.slice(Math.max(0, at - beforeQ.length - 4), at).toLowerCase()
    const after = text
      .slice(at + needle.length, at + needle.length + afterQ.length + 4)
      .toLowerCase()
    // Boundary whitespace between the match and its context is incidental.
    const beforeOk = !beforeQ || before.trimEnd().endsWith(beforeQ)
    const afterOk = !afterQ || after.trimStart().startsWith(afterQ)
    if (beforeOk && afterOk) {
      return { start: map[at]!, end: (map[at + needle.length - 1] ?? at) + 1 }
    }
    from = at + 1
  }
  if (best === null) return null
  return { start: map[best]!, end: (map[best + needle.length - 1] ?? best) + 1 }
}

/** A chapter's visible text plus exact DOM offsets (raw, not normalized). */
export interface TextStream {
  raw: string
  nodes: { node: Text; start: number; end: number }[]
}

export function buildTextStream(root: HTMLElement): TextStream {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const nodes: TextStream['nodes'] = []
  let raw = ''
  let current = walker.nextNode() as Text | null
  while (current) {
    const value = current.nodeValue ?? ''
    if (value.length > 0) {
      if (raw.length > 0) raw += ' ' // join space, like the worker's extractor
      nodes.push({ node: current, start: raw.length, end: raw.length + value.length })
      raw += value
    }
    current = walker.nextNode() as Text | null
  }
  return { raw, nodes }
}

/** Character offsets of a DOM Range within the stream. */
export function offsetsForRange(
  stream: TextStream,
  range: Range,
): { start: number; end: number } | null {
  const startEntry = stream.nodes.find((n) => n.node === range.startContainer)
  const endEntry = stream.nodes.find((n) => n.node === range.endContainer)
  if (!startEntry || !endEntry) return null
  return { start: startEntry.start + range.startOffset, end: endEntry.start + range.endOffset }
}

/** A DOM Range covering [start, end) of the stream (exact raw offsets). */
export function rangeForOffsets(
  doc: Document,
  stream: TextStream,
  start: number,
  end: number,
): Range | null {
  const startEntry = stream.nodes.find((n) => start >= n.start && start <= n.end)
  const endEntry = stream.nodes.find((n) => end > n.start && end <= n.end)
  if (!startEntry || !endEntry) return null
  const range = doc.createRange()
  range.setStart(startEntry.node, start - startEntry.start)
  range.setEnd(endEntry.node, end - endEntry.start)
  return range
}

/** CSS selector path for an element (tag:nth-of-type chains up to root). */
export function selectorForElement(el: Element): string {
  const parts: string[] = []
  let current: Element | null = el
  while (current && current.tagName.toLowerCase() !== 'body') {
    const tag = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    if (!parent) break
    const siblings = [...parent.children].filter((c) => c.tagName === current!.tagName)
    const index = siblings.indexOf(current) + 1
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag)
    current = parent
  }
  return parts.join(' > ')
}

/** Builds the locator for a fresh annotation anchored on a range. */
export function locatorForRange(
  href: string,
  mediaType: string,
  range: Range,
  stream: TextStream,
  progression: number,
): Locator | null {
  const offsets = offsetsForRange(stream, range)
  if (!offsets || offsets.end <= offsets.start) return null
  // Slice raw text (exact offsets); findQuote normalizes both sides when
  // re-anchoring, so raw whitespace in the stored quote is fine.
  const raw = stream.raw
  const locator: Locator = {
    href,
    type: mediaType,
    locations: {
      progression,
      ...(range.startContainer.parentElement
        ? { cssSelector: selectorForElement(range.startContainer.parentElement) }
        : {}),
    },
    text: {
      before: raw.slice(Math.max(0, offsets.start - QUOTE_CONTEXT), offsets.start).trimStart(),
      highlight: raw.slice(offsets.start, offsets.end),
      after: raw.slice(offsets.end, offsets.end + QUOTE_CONTEXT).trimEnd(),
    },
  }
  return locator
}

/** Re-anchors a stored locator in a freshly loaded chapter document. */
export function rangeForLocator(doc: Document, locator: Locator): Range | null {
  const quote = locator.text
  if (!quote?.highlight) return null
  const fullQuote: TextQuote = {
    before: quote.before ?? '',
    highlight: quote.highlight,
    after: quote.after ?? '',
  }

  // Prefer the anchored element's scope when the selector still resolves.
  const selector = locator.locations?.cssSelector
  if (selector) {
    try {
      const el = doc.querySelector(selector)
      if (el instanceof HTMLElement) {
        const scoped = buildTextStream(el)
        const hit = findQuote(scoped.raw, fullQuote)
        if (hit) return rangeForOffsets(doc, scoped, hit.start, hit.end)
      }
    } catch {
      // invalid selector: fall through to global search
    }
  }

  const stream = buildTextStream(doc.body!)
  const hit = findQuote(stream.raw, fullQuote)
  return hit ? rangeForOffsets(doc, stream, hit.start, hit.end) : null
}
