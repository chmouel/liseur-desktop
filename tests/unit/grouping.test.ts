import { describe, expect, it } from 'vitest'
import type { Book, LibraryQuery } from '../../src/shared/domain/types'
import { groupedLibraryEntries } from '../../src/worker/library/grouping'

const query: LibraryQuery = { filter: 'all', sort: 'title', direction: 'asc', search: '' }

function book(partial: Partial<Book> & { id: string; title: string }): Book {
  return {
    authors: ['Author'],
    finished: false,
    archived: false,
    downloaded: true,
    addedAt: 1,
    ...partial,
  }
}

describe('groupedLibraryEntries', () => {
  it('folds two volumes into one stack ordered by their position', () => {
    const one = book({
      id: 'one',
      title: 'Leviathan Wakes',
      series: [{ name: 'The Expanse', position: 1 }],
    })
    const two = book({
      id: 'two',
      title: "Caliban's War",
      series: [{ name: 'The Expanse', position: 2 }],
    })
    const entries = groupedLibraryEntries([one, two], [one, two], query)

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'series', name: 'The Expanse' })
    expect(entries[0]?.kind === 'series' && entries[0].books.map((volume) => volume.id)).toEqual([
      'one',
      'two',
    ])
  })

  it('keeps a complete stack when one volume matches a search', () => {
    const one = book({ id: 'one', title: 'Leviathan Wakes', series: [{ name: 'The Expanse' }] })
    const two = book({ id: 'two', title: "Caliban's War", series: [{ name: 'The Expanse' }] })
    const entries = groupedLibraryEntries([one, two], [one], { ...query, search: 'leviathan' })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind === 'series' && entries[0].books).toEqual([two, one])
  })

  it('retains every liseur-sync membership instead of choosing the first', () => {
    const shared = book({
      id: 'shared',
      title: 'Shared volume',
      series: [
        { name: 'Main sequence', position: 1 },
        { name: 'Companions', position: 1 },
      ],
    })
    const main = book({
      id: 'main',
      title: 'Main two',
      series: [{ name: 'Main sequence', position: 2 }],
    })
    const companion = book({
      id: 'companion',
      title: 'Companion two',
      series: [{ name: 'Companions', position: 2 }],
    })
    const entries = groupedLibraryEntries(
      [shared, main, companion],
      [shared, main, companion],
      query,
    )

    expect(entries.map((entry) => entry.kind === 'series' && entry.name)).toEqual([
      'Companions',
      'Main sequence',
    ])
  })

  it('groups case, accent, and leading-article variants together', () => {
    const one = book({ id: 'one', title: 'One', series: [{ name: "L'Étranger", position: 1 }] })
    const two = book({ id: 'two', title: 'Two', series: [{ name: 'etranger', position: 2 }] })

    expect(groupedLibraryEntries([one, two], [one, two], query)).toHaveLength(1)
  })

  it('sorts recent and added entries in the requested direction', () => {
    const old = book({ id: 'old', title: 'Old', addedAt: 1, lastOpenedAt: 10 })
    const recent = book({ id: 'recent', title: 'Recent', addedAt: 2, lastOpenedAt: 20 })

    expect(
      groupedLibraryEntries([old, recent], [old, recent], {
        ...query,
        sort: 'recent',
        direction: 'desc',
      }).map((entry) => entry.id),
    ).toEqual(['book:recent', 'book:old'])
    expect(
      groupedLibraryEntries([old, recent], [old, recent], {
        ...query,
        sort: 'added',
        direction: 'asc',
      }).map((entry) => entry.id),
    ).toEqual(['book:old', 'book:recent'])
  })
})
