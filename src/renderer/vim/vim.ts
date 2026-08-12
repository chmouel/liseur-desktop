/**
 * Vim mode, renderer side: the setting itself and the little session object
 * the two screens feed their key events to.
 *
 * The setting is off by default. Someone who has never heard of vim must
 * never have `j` do something surprising, and someone who has can turn it on
 * once and find it on every screen.
 */

import { createSignal } from 'solid-js'
import {
  advance,
  isIdle,
  pendingText,
  tokenFor,
  VIM_IDLE,
  type VimBinding,
  type VimKeyEvent,
  type VimState,
} from './keymap'

const [vimMode, setVimModeSignal] = createSignal(false)

/** Whether vim keys are live. Reactive: turning it off takes effect at once. */
export { vimMode }

/**
 * Reads the persisted setting and follows later changes. Settings live in
 * main (a few hundred bytes of JSON), so this is one async read at startup
 * and nothing afterwards — no polling, no timer.
 */
export function initVimMode(): void {
  void window.liseur.settings
    .get()
    .then((settings) => setVimModeSignal(settings.vimMode ?? false))
    .catch((err) => console.error('failed to read the vim mode setting', err))
  window.liseur.settings.onChanged((settings) => setVimModeSignal(settings.vimMode ?? false))
}

/** Flips the setting: signal first (same frame), persistence after. */
export function setVimMode(enabled: boolean): void {
  setVimModeSignal(enabled)
  void window.liseur.settings
    .set({ vimMode: enabled })
    .catch((err) => console.error('failed to persist the vim mode setting', err))
}

/**
 * How long a half-typed sequence waits for its next key before giving up —
 * vim's `timeoutlen`, near enough. A `g` left over from ten minutes ago
 * turning the next `g` into `gg` is worse than having to type it again.
 *
 * The timer only exists while a sequence is pending, so an idle app has none.
 */
const SEQUENCE_TIMEOUT_MS = 1200

export interface VimSession<Command extends string> {
  /** The half-typed sequence, e.g. `2g`, or '' — for the on-screen hint. */
  pending: () => string
  /**
   * Offers a key to vim mode. Returns true when vim consumed it (the caller
   * must not also act on it); false means "not mine", and the caller falls
   * through to its plain handling.
   */
  handle(
    event: VimKeyEvent & { preventDefault(): void; target?: unknown },
    run: (command: Command, count: number | null) => void,
  ): boolean
  /** Drops any half-typed sequence and its timer. */
  reset(): void
}

/** True while the keyboard belongs to a text field rather than to the app. */
function typingInAField(target: unknown): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null
  if (!element) return false
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable === true
  )
}

export function createVimSession<Command extends string>(
  bindings: readonly VimBinding<Command>[],
  enabled: () => boolean = vimMode,
): VimSession<Command> {
  let state: VimState = VIM_IDLE
  const [pending, setPending] = createSignal('')
  let timer: ReturnType<typeof setTimeout> | undefined

  function apply(next: VimState): void {
    state = next
    setPending(pendingText(next))
    clearTimeout(timer)
    timer = undefined
    if (!isIdle(next)) {
      timer = setTimeout(() => {
        state = VIM_IDLE
        setPending('')
      }, SEQUENCE_TIMEOUT_MS)
    }
  }

  return {
    pending,
    reset: () => apply(VIM_IDLE),
    handle(event, run) {
      if (!enabled()) return false
      if (typingInAField(event.target)) {
        apply(VIM_IDLE)
        return false
      }
      const token = tokenFor(event)
      if (token === null) {
        // A named key (an arrow, F11) is the app's, and it also ends any
        // sequence in progress: `g<Left>` is not a vim command.
        if (!isIdle(state)) apply(VIM_IDLE)
        return false
      }
      const step = advance(bindings, state, token)
      apply(step.state)
      switch (step.type) {
        case 'command':
          event.preventDefault()
          run(step.command, step.count)
          return true
        case 'pending':
        case 'cancelled':
          event.preventDefault()
          return true
        case 'unhandled':
          return false
      }
    },
  }
}

/** Repeats an action `count` times (a missing count means once). */
export function times(count: number | null, action: () => void): void {
  for (let i = 0; i < Math.max(1, count ?? 1); i++) action()
}
