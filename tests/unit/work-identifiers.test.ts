import { describe, it, expect } from 'vitest'
import {
  sourceIdentifier,
  titleAuthor,
  workIdentifiers,
} from '../../src/worker/sync/work-identifiers'

// These are the phone's own test vectors (app/src/test/.../WorkIdentifiersTest.kt).
// The server matches these strings literally, so the day the two apps spell an
// identifier differently is the day they stop agreeing about which book is
// which — silently, because neither is ever told.
describe('the names a book is offered to a sync server under', () => {
  it('offers every identifier, strongest first', () => {
    const identifiers = workIdentifiers({
      fileHash: 'AABB',
      sourceId: 'komga:0K1Q',
      dcIdentifier: 'urn:isbn:9780765387561',
      title: 'A Memory Called Empire',
      author: 'Arkady Martine',
    })

    expect(identifiers.map((i) => i.kind)).toEqual(['sha256', 'source', 'dc', 'ta'])
    // Hashes go up as hex and are compared lowercased everywhere.
    expect(identifiers[0]?.value).toBe('aabb')
  })

  it('still has something to say for a book with no file', () => {
    // Catalog entries nobody has downloaded are exactly the ones a reader
    // most wants their place kept for.
    const identifiers = workIdentifiers({
      sourceId: 'komga:2f9b',
      dcIdentifier: 'urn:uuid:2f9b',
      title: 'Piranesi',
      author: 'Susanna Clarke',
    })

    expect(identifiers.map((i) => i.kind)).toEqual(['source', 'dc', 'ta'])
  })

  it('offers nothing for a book with nothing to say for itself', () => {
    expect(workIdentifiers({})).toEqual([])
  })

  it('does not send placeholder identifiers', () => {
    // Several tools stamp the same dc:identifier into every file they
    // produce; taking one at face value would merge a whole library.
    const identifiers = workIdentifiers({
      dcIdentifier: 'urn:uuid:00000000-0000-0000-0000-000000000000',
      title: 'Piranesi',
    })

    expect(identifiers.map((i) => i.kind)).toEqual(['ta'])
    expect(workIdentifiers({ dcIdentifier: 'calibre_id', title: 'Piranesi' })).toHaveLength(1)
  })

  it('does not let case, accents or punctuation make two books', () => {
    expect(titleAuthor("L'Étranger", 'Albert Camus')).toBe(
      titleAuthor('  l’etranger ', 'albert   camus'),
    )
  })

  it('does not treat an author alone as a book', () => {
    // Otherwise every unnamed file by one writer collapses into a single
    // identity and they trade each other's reading positions.
    expect(titleAuthor(undefined, 'Arkady Martine')).toBeNull()
    expect(titleAuthor('   ', 'Arkady Martine')).toBeNull()
  })

  it('treats a title without an author as still a title', () => {
    expect(titleAuthor('Piranesi', undefined)).toBe('piranesi|')
  })

  it('does not treat two authors as the same book by one of them', () => {
    expect(titleAuthor('Dune', 'Frank Herbert')).toBe('dune|frank herbert')
    expect(titleAuthor('Dune', 'Frank Herbert, Brian Herbert')).toBe(
      'dune|frank herbert brian herbert',
    )
  })

  it('names a catalog book the way the phone names it', () => {
    // The one identifier two devices share before either has downloaded
    // anything, so it is what matches the phone's copy against this one.
    expect(sourceIdentifier('komga', '0R57273Q6Z0PD')).toBe('komga:0R57273Q6Z0PD')
    expect(sourceIdentifier('calibre', 'abc')).toBe('calibre:abc')
    // A local file's path names this machine and nothing else.
    expect(sourceIdentifier(undefined, '0R57')).toBeUndefined()
    expect(sourceIdentifier('komga', undefined)).toBeUndefined()
    // A liseur-sync server is not a catalog: it has no id of its own to give.
    expect(sourceIdentifier('liseur-sync', 'work-1')).toBeUndefined()
  })
})
