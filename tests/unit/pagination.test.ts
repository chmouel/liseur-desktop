import { describe, expect, it } from 'vitest'
import {
  clampPage,
  pageCountFor,
  pageForProgression,
  progressionInItem,
  targetForProgression,
  totalProgression,
} from '../../src/renderer/reader/pagination'

describe('pageCountFor', () => {
  it('divides content into viewport pages', () => {
    expect(pageCountFor(1000, 500)).toBe(2)
    expect(pageCountFor(1001, 500)).toBe(3)
    expect(pageCountFor(500, 500)).toBe(1)
    expect(pageCountFor(0, 500)).toBe(1) // empty chapter still has a page
  })

  it('degenerates safely', () => {
    expect(pageCountFor(1000, 0)).toBe(1)
  })
})

describe('clampPage / pageForProgression', () => {
  it('clamps into range', () => {
    expect(clampPage(-5, 10)).toBe(0)
    expect(clampPage(99, 10)).toBe(9)
    expect(clampPage(3, 10)).toBe(3)
  })

  it('restores a saved progression to the same page', () => {
    const count = 20
    const page = 7
    expect(pageForProgression(progressionInItem(page, count), count)).toBe(page)
  })

  it('progression 0 lands on the first page', () => {
    expect(pageForProgression(0, 10)).toBe(0)
  })
})

describe('totalProgression', () => {
  it('weights items by measured page counts', () => {
    // Two items of 10 pages each; page 5 of item 1 → (10 + 5) / 20 = 0.75
    expect(totalProgression([10, 10], 1, 5)).toBe(0.75)
    expect(totalProgression([10, 10], 0, 0)).toBe(0)
  })

  it('estimates unmeasured items from measured ones', () => {
    // Item 0 measured at 10; item 1 estimated at 10 → total 20.
    expect(totalProgression([10, null], 0, 5)).toBeCloseTo(0.25)
  })

  it('never exceeds 1 and handles empties', () => {
    expect(totalProgression([], 0, 0)).toBe(0)
    expect(totalProgression([10], 0, 10)).toBe(1)
  })

  it('non-linear items (count 0) do not weigh on the total', () => {
    // items: 10 pages linear, non-linear, 10 pages linear → total 20
    expect(totalProgression([10, 0, 10], 2, 5)).toBe(0.75)
    expect(totalProgression([10, 0, 10], 2, 0)).toBe(0.5)
  })
})

describe('targetForProgression', () => {
  it('maps fractions onto items and in-item progression', () => {
    expect(targetForProgression([10, 10], 0)).toEqual({ spineIndex: 0, itemProgression: 0 })
    expect(targetForProgression([10, 10], 0.5)).toEqual({ spineIndex: 1, itemProgression: 0 })
    expect(targetForProgression([10, 10], 0.75)).toEqual({ spineIndex: 1, itemProgression: 0.5 })
  })

  it('clamps the end onto the last navigable item', () => {
    expect(targetForProgression([10, 10], 1)).toEqual({ spineIndex: 1, itemProgression: 1 })
    expect(targetForProgression([10, 10], 42)).toEqual({ spineIndex: 1, itemProgression: 1 })
  })

  it('skips non-linear items', () => {
    // middle item is non-linear (0 pages): fraction 0.5 lands on item 2
    expect(targetForProgression([10, 0, 10], 0.5)).toEqual({
      spineIndex: 2,
      itemProgression: 0,
    })
  })

  it('estimates unmeasured items from measured ones', () => {
    expect(targetForProgression([10, null], 0.5)).toEqual({ spineIndex: 1, itemProgression: 0 })
  })

  it('degenerates safely', () => {
    expect(targetForProgression([], 0.5)).toEqual({ spineIndex: 0, itemProgression: 0 })
    expect(targetForProgression([0, 0], 0.5)).toEqual({ spineIndex: 0, itemProgression: 0 })
  })
})
