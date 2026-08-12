import { describe, expect, it } from 'vitest'
import {
  advance,
  formatBinding,
  groupBindings,
  isIdle,
  LIBRARY_BINDINGS,
  MAX_COUNT,
  pendingText,
  READER_BINDINGS,
  tokenFor,
  VIM_IDLE,
  type VimBinding,
} from '../../src/renderer/vim/keymap'

type TestCommand = 'first' | 'last' | 'down' | 'half' | 'rowStart' | 'open'

const BINDINGS: readonly VimBinding<TestCommand>[] = [
  { keys: ['g', 'g'], command: 'first', group: 'move', description: 'first' },
  { keys: ['G'], command: 'last', group: 'move', description: 'last', count: 'target' },
  { keys: ['j'], command: 'down', group: 'move', description: 'down', count: 'repeat' },
  { keys: ['<C-d>'], command: 'half', group: 'move', description: 'half a screen' },
  { keys: ['0'], command: 'rowStart', group: 'move', description: 'row start' },
  { keys: ['<CR>'], command: 'open', group: 'open', description: 'open' },
]

/** Feeds a whole typed sequence, returning every step it produced. */
function type(keys: string[]) {
  let state = VIM_IDLE
  return keys.map((token) => {
    const step = advance(BINDINGS, state, token)
    state = step.state
    return step
  })
}

describe('tokenFor', () => {
  it('names the keys the way vim writes them', () => {
    expect(tokenFor({ key: 'j' })).toBe('j')
    expect(tokenFor({ key: 'G', shiftKey: true })).toBe('G')
    expect(tokenFor({ key: 'Escape' })).toBe('<Esc>')
    expect(tokenFor({ key: 'Enter' })).toBe('<CR>')
    expect(tokenFor({ key: ' ' })).toBe('<Space>')
    expect(tokenFor({ key: 'd', ctrlKey: true })).toBe('<C-d>')
    // Control chords are case-insensitive: Ctrl+Shift+D is still <C-d>.
    expect(tokenFor({ key: 'D', ctrlKey: true, shiftKey: true })).toBe('<C-d>')
  })

  it('leaves the app its own keys', () => {
    // Arrows, function keys and Tab keep behaving like an application's.
    expect(tokenFor({ key: 'ArrowDown' })).toBeNull()
    expect(tokenFor({ key: 'F11' })).toBeNull()
    expect(tokenFor({ key: 'Tab' })).toBeNull()
    expect(tokenFor({ key: 'ArrowDown', ctrlKey: true })).toBeNull()
  })

  it('never claims a chord that belongs to the menu bar or the system', () => {
    expect(tokenFor({ key: 'f', metaKey: true })).toBeNull()
    expect(tokenFor({ key: ',', metaKey: true })).toBeNull()
    expect(tokenFor({ key: 'j', altKey: true })).toBeNull()
  })
})

describe('advance', () => {
  it('resolves a single key to its command', () => {
    const [step] = type(['j'])
    expect(step).toMatchObject({ type: 'command', command: 'down', count: null })
    expect(isIdle(step!.state)).toBe(true)
  })

  it('waits for the rest of a multi-key sequence', () => {
    const [first, second] = type(['g', 'g'])
    expect(first).toMatchObject({ type: 'pending' })
    expect(pendingText(first!.state)).toBe('g')
    expect(second).toMatchObject({ type: 'command', command: 'first' })
  })

  it('abandons a sequence that goes nowhere, without acting', () => {
    const [, second] = type(['g', 'x'])
    expect(second).toMatchObject({ type: 'unhandled' })
    expect(isIdle(second!.state)).toBe(true)
  })

  it('collects a count and hands it to the command', () => {
    const steps = type(['1', '2', 'j'])
    expect(pendingText(steps[1]!.state)).toBe('12')
    expect(steps[2]).toMatchObject({ type: 'command', command: 'down', count: 12 })
  })

  it('counts a leading zero as the command, not as a digit', () => {
    const [step] = type(['0'])
    expect(step).toMatchObject({ type: 'command', command: 'rowStart', count: null })
  })

  it('takes a zero inside a count', () => {
    const steps = type(['1', '0', 'j'])
    expect(steps[2]).toMatchObject({ type: 'command', count: 10 })
  })

  it('refuses to grow a count past what anyone means', () => {
    const steps = type(['9', '9', '9', '9', '9', 'j'])
    expect(pendingText(steps[4]!.state)).toBe('999')
    expect(steps[5]).toMatchObject({ type: 'command', count: MAX_COUNT })
  })

  it('carries the count across a multi-key sequence', () => {
    const steps = type(['3', 'g', 'g'])
    expect(steps[2]).toMatchObject({ type: 'command', command: 'first', count: 3 })
  })

  it('cancels a half-typed sequence on Escape', () => {
    const steps = type(['2', '<Esc>'])
    expect(steps[1]).toMatchObject({ type: 'cancelled' })
    expect(isIdle(steps[1]!.state)).toBe(true)
  })

  it('leaves an idle Escape to the app — it is how you leave a book', () => {
    const [step] = type(['<Esc>'])
    expect(step).toMatchObject({ type: 'unhandled' })
  })

  it('resolves control chords', () => {
    const [step] = type(['<C-d>'])
    expect(step).toMatchObject({ type: 'command', command: 'half' })
  })

  it('does not claim keys nothing is bound to', () => {
    expect(type(['z'])[0]).toMatchObject({ type: 'unhandled' })
  })
})

describe('the shipped keymaps', () => {
  const maps = [
    { name: 'library', bindings: LIBRARY_BINDINGS },
    { name: 'reader', bindings: READER_BINDINGS },
  ]

  for (const { name, bindings } of maps) {
    it(`${name}: no two bindings claim the same keys`, () => {
      const written = bindings.map((binding) => binding.keys.join(' '))
      expect(new Set(written).size).toBe(written.length)
    })

    it(`${name}: no binding is hidden behind a shorter one`, () => {
      // An exact match wins immediately, so `g` bound alongside `gg` would
      // make `gg` unreachable.
      for (const binding of bindings) {
        if (binding.keys.length < 2) continue
        const prefix = binding.keys.slice(0, -1).join(' ')
        expect(bindings.some((other) => other.keys.join(' ') === prefix)).toBe(false)
      }
    })

    it(`${name}: every binding is documented`, () => {
      for (const binding of bindings) {
        expect(binding.description.length).toBeGreaterThan(0)
        expect(binding.group.length).toBeGreaterThan(0)
      }
    })

    it(`${name}: every key of the map resolves`, () => {
      for (const binding of bindings) {
        let state = VIM_IDLE
        let last
        for (const token of binding.keys) {
          last = advance(bindings, state, token)
          state = last.state
        }
        expect(last).toMatchObject({ type: 'command', command: binding.command })
      }
    })
  }

  it('writes the count prefix into the help sheet', () => {
    const G = READER_BINDINGS.find((b) => b.keys.join('') === 'G')!
    expect(formatBinding(G)).toBe('{count}G')
    expect(formatBinding({ keys: ['<C-o>'], command: 'x', group: 'g', description: 'd' })).toBe(
      '<C-o>',
    )
  })

  it('groups the help sheet in the order the groups first appear', () => {
    const groups = groupBindings(LIBRARY_BINDINGS)
    expect(groups.map((g) => g.group)).toEqual([...new Set(LIBRARY_BINDINGS.map((b) => b.group))])
    expect(groups.reduce((n, g) => n + g.bindings.length, 0)).toBe(LIBRARY_BINDINGS.length)
  })
})
