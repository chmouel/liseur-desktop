import { describe, expect, it } from 'vitest'
import { computeColumns, computeRange } from '../../src/renderer/library/virtualize'

describe('computeColumns', () => {
  it('fits as many cards as width allows', () => {
    // card 128 + gap 20 → each column costs 148 after the first 128
    expect(computeColumns(128, 128, 20)).toBe(1)
    expect(computeColumns(276, 128, 20)).toBe(2)
    expect(computeColumns(1280, 128, 20)).toBe(8)
  })

  it('never returns less than 1', () => {
    expect(computeColumns(0, 128, 20)).toBe(1)
    expect(computeColumns(50, 128, 20)).toBe(1)
  })
})

describe('computeRange', () => {
  it('renders only visible rows plus overscan', () => {
    // 5000 items, 8 columns → 625 rows of 256px → 160_000px tall
    const r = computeRange(5000, 8, 256, 0, 800)
    expect(r.totalHeight).toBe(625 * 256)
    expect(r.start).toBe(0)
    // 800px viewport shows ~4 rows; +3 overscan → 7 rows → 56 items
    expect(r.end).toBeLessThanOrEqual(8 * 8)
    expect(r.end).toBeGreaterThan(0)
  })

  it('windows correctly when scrolled to the middle', () => {
    const scrollTop = 100 * 256
    const r = computeRange(5000, 8, 256, scrollTop, 800)
    expect(r.offsetTop).toBe(97 * 256)
    expect(r.start).toBe(97 * 8)
    expect(r.end).toBeGreaterThan(104 * 8)
  })

  it('clamps at the end of the list', () => {
    const r = computeRange(5000, 8, 256, 624 * 256, 800)
    expect(r.end).toBe(5000)
  })

  it('handles empty lists', () => {
    const r = computeRange(0, 8, 256, 0, 800)
    expect(r).toMatchObject({ start: 0, end: 0, totalHeight: 0 })
  })

  it('ignores scroll spent on a header above the grid', () => {
    // 300px header: scrolling 300px only reaches the first row.
    const flush = computeRange(5000, 8, 256, 0, 800)
    const scrolled = computeRange(5000, 8, 256, 300, 800, 3, 300)
    expect(scrolled.start).toBe(flush.start)
    expect(scrolled.offsetTop).toBe(0)
  })

  it('offsets rows by the header height when scrolled past it', () => {
    const withHeader = computeRange(5000, 8, 256, 100 * 256 + 300, 800, 3, 300)
    const without = computeRange(5000, 8, 256, 100 * 256, 800)
    expect(withHeader).toEqual(without)
  })

  it('never lets a header push the effective scroll negative', () => {
    const r = computeRange(5000, 8, 256, 50, 800, 3, 300)
    expect(r.start).toBe(0)
    expect(r.offsetTop).toBe(0)
  })
})
