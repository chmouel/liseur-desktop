import type { Book, BookId } from '../../shared/domain/types'

/**
 * Deterministic fake dataset for Milestone 1.
 *
 * 5,000 books generated from a seeded PRNG (mulberry32) so every run —
 * including tests and profiling — sees the identical library. This validates
 * the async worker→renderer path that SQLite will replace in Milestone 2.
 */

// mulberry32: tiny fast seeded PRNG.
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIRST_WORDS = [
  'The',
  'A',
  'Beyond',
  'Beneath',
  'Toward',
  'Against',
  'Inside',
  'Across',
  'Under',
  'Between',
  'After',
  'Before',
  'Without',
  'Within',
  'Around',
] as const

const SECOND_WORDS = [
  'River',
  'Glass',
  'Harbor',
  'Winter',
  'Ember',
  'Mirror',
  'Garden',
  'Signal',
  'Lantern',
  'Mountain',
  'Cipher',
  'Orchard',
  'Compass',
  'Archive',
  'Tide',
  'Labyrinth',
  'Meridian',
  'Thicket',
  'Observatory',
  'Cartographer',
] as const

const THIRD_WORDS = [
  'of Stars',
  'of Dust',
  'at Dawn',
  'in Autumn',
  'of Salt',
  'of Thorns',
  'of the North',
  'at Midnight',
  'of Light',
  'of the Deep',
  'Reborn',
  'Remembered',
  'Unwritten',
  'Undone',
  'Revealed',
  'Forever',
  'Descending',
  'Awakening',
  'of Silence',
  'of the Quiet Hours',
] as const

const GIVEN_NAMES = [
  'Amara',
  'Elias',
  'Ines',
  'Jonas',
  'Lea',
  'Matteo',
  'Nadia',
  'Otto',
  'Priya',
  'Rafael',
  'Sana',
  'Tomas',
  'Uma',
  'Viktor',
  'Wren',
  'Yusuf',
  'Zora',
  'Anselm',
  'Blythe',
  'Cassian',
] as const

const SURNAMES = [
  'Ashford',
  'Bell',
  'Cross',
  'Delacroix',
  'Ellery',
  'Frost',
  'Grey',
  'Halloway',
  'Ibarra',
  'Jonker',
  'Kaur',
  'Lindqvist',
  'Moreau',
  'Novak',
  'Okafor',
  'Petrov',
  'Quinn',
  'Reyes',
  'Sato',
  'Tanaka',
] as const

export const FAKE_LIBRARY_SIZE = 5000
export const FAKE_LIBRARY_SEED = 0x5eed

export function generateFakeLibrary(size = FAKE_LIBRARY_SIZE, seed = FAKE_LIBRARY_SEED): Book[] {
  const rng = makeRng(seed)
  const books: Book[] = []

  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!

  const now = Date.now()
  const day = 86_400_000

  for (let i = 0; i < size; i++) {
    const id: BookId = `fake-${i}`
    const title = `${pick(FIRST_WORDS)} ${pick(SECOND_WORDS)} ${pick(THIRD_WORDS)}`
    const authorCount = rng() > 0.85 ? 2 : 1
    const authors: string[] = []
    for (let a = 0; a < authorCount; a++) {
      authors.push(`${pick(GIVEN_NAMES)} ${pick(SURNAMES)}`)
    }

    const addedAt = now - Math.floor(rng() * 900) * day
    const hasProgress = rng() < 0.45
    const finished = hasProgress && rng() < 0.25
    const archived = rng() < 0.08
    const downloaded = rng() < 0.6

    const book: Book = {
      id,
      title,
      authors,
      downloaded,
      finished,
      archived,
      addedAt,
    }

    if (rng() < 0.5) {
      book.lastOpenedAt = now - Math.floor(rng() * 60) * day
    }

    if (hasProgress) {
      const progression = finished ? 1 : 0.02 + rng() * 0.96
      book.progress = {
        locator: {
          href: `text/chapter-${1 + Math.floor(rng() * 20)}.xhtml`,
          type: 'application/xhtml+xml',
          locations: {
            progression: rng(),
            totalProgression: progression,
          },
        },
        progression,
        updatedAt: book.lastOpenedAt ?? addedAt,
      }
    }

    books.push(book)
  }

  return books
}
