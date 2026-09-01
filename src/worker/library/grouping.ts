import type {
  Book,
  LibraryEntry,
  LibraryQuery,
  LibrarySeriesEntry,
} from '../../shared/domain/types'

/**
 * Folds the shelf exactly as Android does: a series belongs under its
 * normalized display name, not a server id, so a downloaded copy and its
 * catalog sibling do not become two stacks. A repeated title is the rare
 * trade-off for keeping the common local-plus-server case together.
 */
function sortKey(value: string): string {
  const folded = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLocaleLowerCase()
  for (const elision of ["l'", 'l’', "d'", 'd’']) {
    if (folded.startsWith(elision) && folded.slice(elision.length).trim()) {
      return folded.slice(elision.length).trimStart()
    }
  }
  const article = /^(?:the|a|an|le|la|les|un|une|des|du|de)\s+/.exec(folded)
  return article ? folded.slice(article[0].length) : folded
}

function seriesKey(name: string): string {
  return sortKey(name)
}

function membershipFor(book: Book, key: string) {
  return book.series?.find((membership) => seriesKey(membership.name) === key)
}

function commonest(values: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return values.reduce((best, value) =>
    (counts.get(value) ?? 0) > (counts.get(best) ?? 0) ? value : best,
  )
}

function volumeOrder(key: string, left: Book, right: Book): number {
  const leftPosition = membershipFor(left, key)?.position
  const rightPosition = membershipFor(right, key)?.position
  const leftKnown = leftPosition !== undefined
  const rightKnown = rightPosition !== undefined
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1
  if (leftPosition !== rightPosition) return (leftPosition ?? 0) - (rightPosition ?? 0)
  return sortKey(left.title).localeCompare(sortKey(right.title)) || left.id.localeCompare(right.id)
}

function seriesEntries(books: readonly Book[]): LibrarySeriesEntry[] {
  const bySeries = new Map<string, Book[]>()
  for (const book of books) {
    for (const membership of book.series ?? []) {
      const key = seriesKey(membership.name)
      if (!key) continue
      const volumes = bySeries.get(key)
      if (volumes) volumes.push(book)
      else bySeries.set(key, [book])
    }
  }

  return [...bySeries.entries()].flatMap(([key, volumes]) => {
    // A series of one stays a normal book card. Opening a page that contains
    // exactly the card it replaced adds friction without helping discovery.
    if (volumes.length < 2) return []
    const ordered = [...volumes].sort((left, right) => volumeOrder(key, left, right))
    const cover =
      ordered.find((book) => {
        const progression = book.progress?.progression ?? 0
        return !book.finished && progression > 0 && progression < 1
      }) ??
      ordered.find((book) => !book.finished) ??
      ordered[0]
    if (!cover) return []
    const names = volumes.flatMap((book) =>
      (book.series ?? [])
        .filter((membership) => seriesKey(membership.name) === key)
        .map((membership) => membership.name),
    )
    const authors = volumes.flatMap((book) => book.authors).filter(Boolean)
    return [
      {
        kind: 'series' as const,
        id: `series:${key}`,
        name: commonest(names),
        authors: authors.length > 0 ? [commonest(authors)] : [],
        books: ordered,
        cover,
      },
    ]
  })
}

function recentAt(book: Book): number {
  return Math.max(book.lastOpenedAt ?? 0, book.progress?.updatedAt ?? 0, book.addedAt)
}

function compareEntries(query: LibraryQuery, left: LibraryEntry, right: LibraryEntry): number {
  const title = (entry: LibraryEntry) => (entry.kind === 'series' ? entry.name : entry.book.title)
  const authors = (entry: LibraryEntry) =>
    entry.kind === 'series' ? entry.authors : entry.book.authors
  const books = (entry: LibraryEntry) => (entry.kind === 'series' ? entry.books : [entry.book])
  const direction = query.direction === 'asc' ? 1 : -1
  let compared = 0
  switch (query.sort) {
    case 'recent':
      compared = Math.max(...books(left).map(recentAt)) - Math.max(...books(right).map(recentAt))
      break
    case 'added':
      compared =
        Math.max(...books(left).map((book) => book.addedAt)) -
        Math.max(...books(right).map((book) => book.addedAt))
      break
    case 'author': {
      const leftAuthor = authors(left)[0]
      const rightAuthor = authors(right)[0]
      if (!leftAuthor || !rightAuthor) compared = leftAuthor ? -1 : rightAuthor ? 1 : 0
      else compared = sortKey(leftAuthor).localeCompare(sortKey(rightAuthor))
      break
    }
    case 'title':
      compared = sortKey(title(left)).localeCompare(sortKey(title(right)))
      break
  }
  compared *= direction
  return (
    compared ||
    sortKey(title(left)).localeCompare(sortKey(title(right))) ||
    left.id.localeCompare(right.id)
  )
}

/**
 * Produces the cards for one query. `visible` is the search result; `books`
 * is the filter result before search, so a stack stays complete when one of
 * its volumes matches the query.
 */
export function groupedLibraryEntries(
  books: readonly Book[],
  visible: readonly Book[],
  query: LibraryQuery,
): LibraryEntry[] {
  const stacks = seriesEntries(books)
  const visibleIds = new Set(visible.map((book) => book.id))
  const shownStacks = stacks.filter((stack) => stack.books.some((book) => visibleIds.has(book.id)))
  const stackedSeries = new Set(
    shownStacks.flatMap((stack) =>
      stack.books.flatMap((book) =>
        (book.series ?? []).map((membership) => seriesKey(membership.name)),
      ),
    ),
  )
  const singles: LibraryEntry[] = visible
    .filter(
      (book) =>
        !(book.series ?? []).some((membership) => stackedSeries.has(seriesKey(membership.name))),
    )
    .map((book) => ({ kind: 'book', id: `book:${book.id}`, book }))
  return [...shownStacks, ...singles].sort((left, right) => compareEntries(query, left, right))
}
