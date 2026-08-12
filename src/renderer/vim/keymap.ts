/**
 * Vim mode — key resolution, kept pure and DOM-free so the whole grammar is
 * unit-testable without a window.
 *
 * The grammar is the small, honest subset of vim that a reading application
 * can mean something by: an optional count, then a key sequence that may be
 * more than one key long (`gg`, `]]`). Everything else vim does — operators,
 * registers, modes — has no counterpart here and is deliberately absent.
 *
 * Vim mode is ADDITIVE. Arrows, space, Escape and the menu accelerators keep
 * working exactly as they do with it off; these bindings are consulted first
 * and anything they do not claim falls through to the plain handler. Nothing
 * a person already knows stops working because they turned this on.
 */

/**
 * One key, written the way vim writes it: a bare character, `<C-d>` for a
 * control chord, or a name (`<Esc>`, `<CR>`, `<Space>`).
 */
export type VimToken = string

/** Just enough of a KeyboardEvent to resolve a key — including the ones the
 *  reader forwards out of the book iframe. */
export interface VimKeyEvent {
  key: string
  ctrlKey?: boolean | undefined
  altKey?: boolean | undefined
  metaKey?: boolean | undefined
  shiftKey?: boolean | undefined
}

/** How a leading count changes what a command means, for the help sheet. */
export type VimCountUse =
  /** `3j` — do it three times. */
  | 'repeat'
  /** `12G` — go to the twelfth thing. */
  | 'target'

export interface VimBinding<Command extends string> {
  keys: readonly VimToken[]
  command: Command
  /** Section heading in the help sheet. */
  group: string
  description: string
  count?: VimCountUse
}

export interface VimState {
  /** Digits typed so far, as text: leading zeros can only be a `0` command. */
  count: string
  keys: readonly VimToken[]
}

export const VIM_IDLE: VimState = { count: '', keys: [] }

export function isIdle(state: VimState): boolean {
  return state.count === '' && state.keys.length === 0
}

/** What a pending sequence looks like in the corner of the screen. */
export function pendingText(state: VimState): string {
  return state.count + state.keys.join('')
}

/**
 * A count is a convenience, not a stress test: five hundred page turns is
 * already more than anyone means, and an accidental `999999j` should not
 * hand the engine a queue it will spend a minute working through.
 */
export const MAX_COUNT = 999

export type VimStep<Command extends string> =
  /** More keys needed: the sequence is a prefix of at least one binding. */
  | { type: 'pending'; state: VimState }
  | { type: 'command'; command: Command; count: number | null; state: VimState }
  /** Escape threw away a half-typed sequence; the app must not also act. */
  | { type: 'cancelled'; state: VimState }
  /** Not ours: the caller falls back to its plain (non-vim) handling. */
  | { type: 'unhandled'; state: VimState }

/**
 * Encodes a key event as a token, or null when vim mode should keep its
 * hands off it.
 *
 * Alt and Cmd are the operating system's and the menu bar's; a chord with
 * them is never a vim binding. Named keys (arrows, function keys, Tab) are
 * left to the plain handlers so the app keeps behaving like an app.
 */
export function tokenFor(event: VimKeyEvent): VimToken | null {
  const { key } = event
  if (event.altKey || event.metaKey) return null
  if (event.ctrlKey) return key.length === 1 ? `<C-${key.toLowerCase()}>` : null
  if (key === 'Escape') return '<Esc>'
  if (key === 'Enter') return '<CR>'
  if (key === ' ') return '<Space>'
  // Anything else with a name rather than a glyph belongs to the app.
  return key.length === 1 ? key : null
}

function sameKeys(a: readonly VimToken[], b: readonly VimToken[]): boolean {
  return a.length === b.length && a.every((token, i) => token === b[i])
}

function isPrefix(prefix: readonly VimToken[], keys: readonly VimToken[]): boolean {
  return keys.length > prefix.length && prefix.every((token, i) => token === keys[i])
}

/**
 * Feeds one token to the state machine.
 *
 * Digits accumulate into a count, except a leading `0`, which is a command
 * of its own (as in vim, where `0` goes to the start of the line). An exact
 * match wins immediately over a longer binding it prefixes — there is no
 * timeout-based ambiguity in these maps, and none should be introduced.
 */
export function advance<Command extends string>(
  bindings: readonly VimBinding<Command>[],
  state: VimState,
  token: VimToken,
): VimStep<Command> {
  if (token === '<Esc>') {
    // Escape only belongs to vim while something is half-typed; otherwise it
    // is the reader's way out and must reach the app untouched.
    return isIdle(state)
      ? { type: 'unhandled', state: VIM_IDLE }
      : { type: 'cancelled', state: VIM_IDLE }
  }

  if (state.keys.length === 0 && /^[0-9]$/.test(token) && !(token === '0' && state.count === '')) {
    // Stop growing the count rather than dropping the key: silently
    // truncating digits would run a command with a number nobody typed.
    const count = state.count.length >= String(MAX_COUNT).length ? state.count : state.count + token
    return { type: 'pending', state: { count, keys: [] } }
  }

  const keys = [...state.keys, token]
  const exact = bindings.find((binding) => sameKeys(binding.keys, keys))
  if (exact) {
    const count = state.count === '' ? null : Math.min(MAX_COUNT, Number(state.count))
    return { type: 'command', command: exact.command, count, state: VIM_IDLE }
  }
  if (bindings.some((binding) => isPrefix(keys, binding.keys))) {
    return { type: 'pending', state: { count: state.count, keys } }
  }
  return { type: 'unhandled', state: VIM_IDLE }
}

/** How a binding is written in the help sheet, count prefix included. */
export function formatBinding(binding: VimBinding<string>): string {
  return (binding.count ? '{count}' : '') + binding.keys.join('')
}

/** Bindings in the order their groups appear, for rendering the help sheet. */
export function groupBindings<Command extends string>(
  bindings: readonly VimBinding<Command>[],
): { group: string; bindings: VimBinding<Command>[] }[] {
  const groups: { group: string; bindings: VimBinding<Command>[] }[] = []
  for (const binding of bindings) {
    const existing = groups.find((g) => g.group === binding.group)
    if (existing) existing.bindings.push(binding)
    else groups.push({ group: binding.group, bindings: [binding] })
  }
  return groups
}

// --- library -------------------------------------------------------------

export type LibraryCommand =
  | 'left'
  | 'right'
  | 'down'
  | 'up'
  | 'rowStart'
  | 'rowEnd'
  | 'first'
  | 'last'
  | 'halfPageDown'
  | 'halfPageUp'
  | 'open'
  | 'search'
  | 'filterNext'
  | 'filterPrev'
  | 'sortNext'
  | 'sortPrev'
  | 'sortReverse'
  | 'continueReading'
  | 'addBooks'
  | 'stats'
  | 'settings'
  | 'help'
  | 'closeOverlay'

const MOVE = 'Moving around'
const SHELF = 'The shelf'
const OPENING = 'Opening things'

export const LIBRARY_BINDINGS: readonly VimBinding<LibraryCommand>[] = [
  { keys: ['h'], command: 'left', group: MOVE, description: 'Previous book', count: 'repeat' },
  { keys: ['l'], command: 'right', group: MOVE, description: 'Next book', count: 'repeat' },
  { keys: ['j'], command: 'down', group: MOVE, description: 'One row down', count: 'repeat' },
  { keys: ['k'], command: 'up', group: MOVE, description: 'One row up', count: 'repeat' },
  { keys: ['0'], command: 'rowStart', group: MOVE, description: 'First book in the row' },
  { keys: ['^'], command: 'rowStart', group: MOVE, description: 'First book in the row' },
  { keys: ['$'], command: 'rowEnd', group: MOVE, description: 'Last book in the row' },
  { keys: ['g', 'g'], command: 'first', group: MOVE, description: 'First book' },
  {
    keys: ['G'],
    command: 'last',
    group: MOVE,
    description: 'Last book, or the count-th one',
    count: 'target',
  },
  {
    keys: ['<C-d>'],
    command: 'halfPageDown',
    group: MOVE,
    description: 'Half a screen down',
  },
  { keys: ['<C-u>'], command: 'halfPageUp', group: MOVE, description: 'Half a screen up' },

  { keys: ['<CR>'], command: 'open', group: OPENING, description: 'Open the selected book' },
  { keys: ['o'], command: 'open', group: OPENING, description: 'Open the selected book' },
  {
    keys: ['c'],
    command: 'continueReading',
    group: OPENING,
    description: 'Carry on with the current book',
  },
  { keys: ['a'], command: 'addBooks', group: OPENING, description: 'Add books…' },

  { keys: ['/'], command: 'search', group: SHELF, description: 'Search the library' },
  { keys: ['f'], command: 'filterNext', group: SHELF, description: 'Next filter' },
  { keys: ['F'], command: 'filterPrev', group: SHELF, description: 'Previous filter' },
  { keys: ['s'], command: 'sortNext', group: SHELF, description: 'Next sort order' },
  { keys: ['S'], command: 'sortPrev', group: SHELF, description: 'Previous sort order' },
  { keys: ['r'], command: 'sortReverse', group: SHELF, description: 'Reverse the sort' },
  { keys: ['g', 's'], command: 'stats', group: SHELF, description: 'Reading statistics' },
  { keys: ['g', 'p'], command: 'settings', group: SHELF, description: 'Settings' },
  { keys: ['?'], command: 'help', group: SHELF, description: 'This list of keys' },
  { keys: ['q'], command: 'closeOverlay', group: SHELF, description: 'Close what is open' },
]

// --- reader --------------------------------------------------------------

export type ReaderCommand =
  | 'nextPage'
  | 'prevPage'
  | 'nextChapter'
  | 'prevChapter'
  | 'chapterStart'
  | 'chapterEnd'
  | 'bookStart'
  | 'bookEnd'
  | 'percent'
  | 'search'
  | 'nextMatch'
  | 'prevMatch'
  | 'toc'
  | 'toggleBookmark'
  | 'bookmarks'
  | 'typography'
  | 'fontBigger'
  | 'fontSmaller'
  | 'toggleColumns'
  | 'fullscreen'
  | 'jumpBack'
  | 'quit'
  | 'help'

const PAGES = 'Turning pages'
const JUMPS = 'Jumping'
const FINDING = 'Finding things'
const PAGE_LOOK = 'How the page looks'

export const READER_BINDINGS: readonly VimBinding<ReaderCommand>[] = [
  { keys: ['l'], command: 'nextPage', group: PAGES, description: 'Next page', count: 'repeat' },
  { keys: ['h'], command: 'prevPage', group: PAGES, description: 'Previous page', count: 'repeat' },
  { keys: ['j'], command: 'nextPage', group: PAGES, description: 'Next page', count: 'repeat' },
  { keys: ['k'], command: 'prevPage', group: PAGES, description: 'Previous page', count: 'repeat' },
  {
    keys: [']', ']'],
    command: 'nextChapter',
    group: PAGES,
    description: 'Next chapter',
    count: 'repeat',
  },
  {
    keys: ['[', '['],
    command: 'prevChapter',
    group: PAGES,
    description: 'Previous chapter',
    count: 'repeat',
  },
  { keys: ['}'], command: 'nextChapter', group: PAGES, description: 'Next chapter' },
  { keys: ['{'], command: 'prevChapter', group: PAGES, description: 'Previous chapter' },

  { keys: ['0'], command: 'chapterStart', group: JUMPS, description: 'Start of the chapter' },
  { keys: ['^'], command: 'chapterStart', group: JUMPS, description: 'Start of the chapter' },
  { keys: ['$'], command: 'chapterEnd', group: JUMPS, description: 'End of the chapter' },
  { keys: ['g', 'g'], command: 'bookStart', group: JUMPS, description: 'Start of the book' },
  {
    keys: ['G'],
    command: 'bookEnd',
    group: JUMPS,
    description: 'End of the book, or chapter count',
    count: 'target',
  },
  {
    keys: ['%'],
    command: 'percent',
    group: JUMPS,
    description: 'Jump that far through the book',
    count: 'target',
  },
  { keys: ['<C-o>'], command: 'jumpBack', group: JUMPS, description: 'Back where you jumped from' },
  { keys: ['q'], command: 'quit', group: JUMPS, description: 'Back to the library' },

  { keys: ['/'], command: 'search', group: FINDING, description: 'Search in the book' },
  { keys: ['n'], command: 'nextMatch', group: FINDING, description: 'Next match', count: 'repeat' },
  {
    keys: ['N'],
    command: 'prevMatch',
    group: FINDING,
    description: 'Previous match',
    count: 'repeat',
  },
  { keys: ['t'], command: 'toc', group: FINDING, description: 'Table of contents' },
  { keys: ['m'], command: 'toggleBookmark', group: FINDING, description: 'Bookmark this page' },
  { keys: ['M'], command: 'bookmarks', group: FINDING, description: 'Bookmarks and notes' },
  { keys: ['?'], command: 'help', group: FINDING, description: 'This list of keys' },

  { keys: ['a'], command: 'typography', group: PAGE_LOOK, description: 'Typography' },
  { keys: ['+'], command: 'fontBigger', group: PAGE_LOOK, description: 'Bigger text' },
  { keys: ['='], command: 'fontBigger', group: PAGE_LOOK, description: 'Bigger text' },
  { keys: ['-'], command: 'fontSmaller', group: PAGE_LOOK, description: 'Smaller text' },
  { keys: ['c'], command: 'toggleColumns', group: PAGE_LOOK, description: 'One or two columns' },
  { keys: ['f'], command: 'fullscreen', group: PAGE_LOOK, description: 'Full screen' },
]
