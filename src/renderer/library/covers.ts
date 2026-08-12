/**
 * Book cover URLs.
 *
 * Books with a real cover (ingested EPUBs, M3) get a `liseur-cover:` URL
 * served from the worker-written thumbnail cache; everything else gets a
 * deterministic inline-SVG placeholder — no decoding storm, no assets, and
 * both kinds lazy-load the same way.
 */

import { coverUrl } from '@shared/ipc/protocol'

const PALETTES: readonly (readonly [string, string])[] = [
  ['#7a4a2b', '#ffdcc3'],
  ['#5c3018', '#e8b48f'],
  ['#3a5f5c', '#bdece6'],
  ['#8b5e3c', '#f5e0cb'],
  ['#2e4a3d', '#c8e6d2'],
  ['#4a3b5c', '#d9c8ec'],
  ['#6e3a3a', '#ecc8c8'],
  ['#3d4a6e', '#c8d2ec'],
]

function hash(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0
  return h >>> 0
}

function initials(title: string): string {
  return title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

const cache = new Map<string, string>()

export function coverFor(book: { id: string; title: string; coverId?: string }): string {
  // Real covers aren't cached client-side: the URL is cheap to compute and
  // Chromium's HTTP cache + the on-disk cache handle the rest.
  if (book.coverId) return coverUrl(book.coverId)

  const hit = cache.get(book.id)
  if (hit) return hit

  const [bg, fg] = PALETTES[hash(book.id) % PALETTES.length]!
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240" viewBox="0 0 160 240">` +
    `<rect width="160" height="240" fill="${bg}"/>` +
    `<rect x="10" y="10" width="140" height="220" fill="none" stroke="${fg}" stroke-width="2" opacity="0.5"/>` +
    `<text x="80" y="128" font-family="Georgia, serif" font-size="44" fill="${fg}" text-anchor="middle">${initials(book.title)}</text>` +
    `</svg>`
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`
  cache.set(book.id, uri)
  return uri
}
