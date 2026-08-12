/**
 * The names liseur-sync knows a book by.
 *
 * This is a port of the phone's `WorkIdentifiers`, and it has to stay one:
 * the server matches these strings literally, so a desktop that spells them
 * differently would file the same book twice and neither device would ever
 * be told they disagree. The unit tests here are the phone's own test
 * vectors for that reason.
 */

/** One way of naming a book, in the vocabulary liseur-sync uses. */
export interface WorkIdentifier {
  kind: 'sha256' | 'partial-md5' | 'source' | 'dc' | 'ta'
  value: string
}

/**
 * Identifiers that name nothing.
 *
 * Publishers are not required to make `dc:identifier` unique and several
 * tools stamp the same placeholder into every file they produce, so taking
 * one at face value would merge a whole library into a single book.
 */
const USELESS_IDENTIFIERS = new Set([
  'urn:uuid:00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000000',
  'urn:uuid:none',
  'none',
  'null',
  'unknown',
  'id',
  'bookid',
  'uuid_id',
  'calibre_id',
])

/**
 * A title or an author reduced to the part two catalogues are likely to
 * agree on: no case, no accents, no punctuation, no repeated spaces.
 *
 * Deliberately dull, and never to be changed casually: this normalisation
 * *is* the interoperability contract with the phone.
 */
function fold(text: string | undefined): string | null {
  if (!text || text.trim() === '') return null
  const flattened = text
    .normalize('NFKD')
    .replace(/\p{Mn}+/gu, '')
    .toLowerCase()
  let kept = ''
  // Walked by UTF-16 unit rather than by code point, because the phone walks
  // Kotlin `Char`s: an astral character collapses to a space there, and has
  // to collapse here too or the two spellings diverge.
  for (let i = 0; i < flattened.length; i += 1) {
    const unit = flattened[i] as string
    if (/[\p{L}\p{Nd}]/u.test(unit)) kept += unit
    else if (kept === '' || !kept.endsWith(' ')) kept += ' '
  }
  return kept.trim() || null
}

/**
 * Title and author folded into the fuzzy last-resort identifier.
 *
 * Null without a title, because an author on their own names a shelf
 * rather than a book: every untitled file by one writer would otherwise
 * collapse into a single identity and they would trade reading positions.
 */
export function titleAuthor(title: string | undefined, author: string | undefined): string | null {
  const left = fold(title)
  if (!left) return null
  return `${left}|${fold(author) ?? ''}`
}

/**
 * Everything this device can say about which book it is holding.
 *
 * The server resolves in a fixed order — exact bytes, then the catalog's
 * own id, then the file's own identifier, then title and author — and
 * registers every identifier it was given against whichever one matched.
 * That is how a re-encoded copy and the original come to be known as the
 * same book, so all of them are always worth sending rather than only the
 * strongest.
 *
 * The phone also offers a `partial-md5` (KOReader's fingerprint), which
 * this app does not compute; anything that matched on it would match on
 * `sha256` here, since both need the file.
 */
export function workIdentifiers(input: {
  fileHash?: string | undefined
  sourceId?: string | undefined
  dcIdentifier?: string | undefined
  title?: string | undefined
  author?: string | undefined
}): WorkIdentifier[] {
  const identifiers: WorkIdentifier[] = []
  const hash = input.fileHash?.trim()
  if (hash) identifiers.push({ kind: 'sha256', value: hash.toLowerCase() })
  const source = input.sourceId?.trim()
  if (source) identifiers.push({ kind: 'source', value: source })
  const dc = input.dcIdentifier?.trim().toLowerCase()
  if (dc && !USELESS_IDENTIFIERS.has(dc)) identifiers.push({ kind: 'dc', value: dc })
  const ta = titleAuthor(input.title, input.author)
  if (ta) identifiers.push({ kind: 'ta', value: ta })
  return identifiers
}

/**
 * The catalog server's own id for a book, in the spelling the phone uses.
 *
 * Two devices browsing the same catalog hold this before either has
 * downloaded the file, which makes it the one identifier that can match a
 * book nobody has downloaded yet.
 */
export function sourceIdentifier(
  serverType: string | undefined,
  remoteId: string | undefined,
): string | undefined {
  if (!remoteId) return undefined
  // Only catalogs the phone also names this way; a local file's path means
  // nothing on another device and is never sent.
  if (serverType !== 'komga' && serverType !== 'calibre') return undefined
  return `${serverType}:${remoteId}`
}
