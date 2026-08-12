import { describe, expect, it } from 'vitest'
import { isPublishableOrigin, type PositionOrigin } from '../../src/renderer/reader/engine'

/**
 * `ColumnEngine` is DOM-heavy (iframe, ResizeObserver, srcdoc) and is
 * exercised end to end by the Playwright reader/sync suites instead of a
 * unit test harness (see AGENTS.md — no new test dependency for a DOM
 * shim). What is pure and exhaustively unit-testable here is the
 * classification every origin the engine emits must resolve to: only a
 * real user navigation is worth persisting or syncing.
 */
describe('isPublishableOrigin', () => {
  it('publishes user-originated navigation (next/prev, TOC, scrubber, search, bookmarks, links)', () => {
    expect(isPublishableOrigin('user')).toBe(true)
  })

  it('does not publish the initial restore — nothing moved, it only loaded', () => {
    expect(isPublishableOrigin('restore')).toBe(false)
  })

  it('does not publish a relayout — resize, font-settling and typography changes preserve position', () => {
    expect(isPublishableOrigin('relayout')).toBe(false)
  })

  it('is exhaustive over every PositionOrigin variant', () => {
    const origins: PositionOrigin[] = ['user', 'restore', 'relayout']
    expect(origins.map(isPublishableOrigin)).toEqual([true, false, false])
  })
})
