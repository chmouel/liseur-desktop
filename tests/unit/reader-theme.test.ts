import { describe, expect, it } from 'vitest'
import {
  buildReaderCss,
  clampFontSize,
  columnGapFor,
  readerMeasurePx,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  DEFAULT_FONT_SIZE,
  clampMeasure,
  marginPresetFor,
  DEFAULT_MEASURE,
  MARGIN_PRESETS,
  MIN_MEASURE,
  MAX_MEASURE,
} from '../../src/renderer/reader/reader-theme'

const prefs = (columns: 1 | 2, fontSize = 18, measure = DEFAULT_MEASURE) => ({
  columns,
  fontSize,
  measure,
})

describe('clampFontSize', () => {
  it('starts at a generous reading size', () => {
    expect(DEFAULT_FONT_SIZE).toBe(20)
  })

  it('keeps sizes within the readable bounds', () => {
    expect(clampFontSize(MIN_FONT_SIZE - 5)).toBe(MIN_FONT_SIZE)
    expect(clampFontSize(MAX_FONT_SIZE + 50)).toBe(MAX_FONT_SIZE)
    expect(clampFontSize(24)).toBe(24)
  })

  it('allows sizes well past the old 40px ceiling', () => {
    expect(MAX_FONT_SIZE).toBeGreaterThan(40)
    expect(clampFontSize(72)).toBe(72)
  })

  it('falls back to the default for a corrupt value', () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE)
  })

  it('rounds, so the displayed size is always a whole number', () => {
    expect(clampFontSize(18.6)).toBe(19)
  })
})

describe('columnGapFor', () => {
  it('gutters side-by-side columns only', () => {
    expect(columnGapFor(1)).toBe(0)
    expect(columnGapFor(2)).toBeGreaterThan(0)
  })
})

describe('readerMeasurePx', () => {
  it('caps the text at a readable measure and scales with the font size', () => {
    expect(readerMeasurePx(prefs(1))).toBeLessThan(readerMeasurePx(prefs(2)))
    expect(readerMeasurePx(prefs(1, 24))).toBeGreaterThan(readerMeasurePx(prefs(1, 18)))
  })

  it('leaves room for the viewport padding and the gutter', () => {
    // Two columns must fit two measures plus one gutter, never less.
    expect(readerMeasurePx(prefs(2))).toBeGreaterThan(
      2 * (readerMeasurePx(prefs(1)) - 96) + columnGapFor(2),
    )
  })
})

describe('buildReaderCss', () => {
  it('loads bundled Literata with standard ligatures', () => {
    const css = buildReaderCss(prefs(1), 1000)
    expect(css).toContain("font-family: 'Liseur Literata'")
    expect(css).toContain("font-feature-settings: 'liga' 1, 'clig' 1, 'calt' 1")
    expect(css).toContain('font-variant-ligatures: common-ligatures contextual')
  })

  it('divides the page into columns, gutters included', () => {
    const css = buildReaderCss(prefs(2), 1000)
    // (1000 - 48) / 2
    expect(css).toContain('column-width: 476px')
    expect(css).toContain('column-count: 2')
    expect(css).toContain('column-gap: 48px')
  })

  it('uses the whole page for a single column', () => {
    const css = buildReaderCss(prefs(1), 1000)
    expect(css).toContain('column-width: 1000px')
    expect(css).toContain('column-gap: 0px')
  })

  it("overrides the publisher's own font sizes, which are absolute", () => {
    const css = buildReaderCss({ ...prefs(1), fontSize: 42 }, 1000)
    // On <html>, so em-based publisher rules still resolve against it.
    expect(css).toMatch(/html\s*\{[^}]*font-size: 42px/)
    // Absolute publisher sizes (`font-size: small`) only lose to !important.
    expect(css).toMatch(/font-size: inherit !important/)
    // Meaningful sizes are restated relatively, so hierarchy survives.
    expect(css).toMatch(/h1[^{]*\{[^}]*font-size: [\d.]+em/)
  })

  it('underlines links but never bare anchor targets', () => {
    const css = buildReaderCss(prefs(1), 1000)
    expect(css).toContain('a[href]')
    expect(css).not.toMatch(/^\s*a \{/m)
  })
})

describe('margins', () => {
  it('uses a comfortable default measure', () => {
    expect(DEFAULT_MEASURE).toBe(34)
  })

  it('keeps a custom width within readable bounds', () => {
    expect(clampMeasure(MIN_MEASURE - 10)).toBe(MIN_MEASURE)
    expect(clampMeasure(MAX_MEASURE + 10)).toBe(MAX_MEASURE)
    expect(clampMeasure(Number.NaN)).toBe(DEFAULT_MEASURE)
    expect(clampMeasure(33.4)).toBe(33)
  })

  it('names the preset a width matches, and nothing for a custom one', () => {
    expect(marginPresetFor(MARGIN_PRESETS.narrow)).toBe('narrow')
    expect(marginPresetFor(MARGIN_PRESETS.normal)).toBe('normal')
    expect(marginPresetFor(MARGIN_PRESETS.wide)).toBe('wide')
    expect(marginPresetFor(MARGIN_PRESETS.normal + 1)).toBeUndefined()
  })

  it('wider margins leave the text less room', () => {
    // The whole point of the control: "wide" has to mean more white space,
    // which is a narrower page, not a wider one.
    const wide = readerMeasurePx(prefs(1, 18, MARGIN_PRESETS.wide))
    const normal = readerMeasurePx(prefs(1, 18, MARGIN_PRESETS.normal))
    const narrow = readerMeasurePx(prefs(1, 18, MARGIN_PRESETS.narrow))
    expect(wide).toBeLessThan(normal)
    expect(normal).toBeLessThan(narrow)
  })

  it('a stored width from another build cannot escape the bounds', () => {
    expect(readerMeasurePx(prefs(1, 18, 999))).toBe(readerMeasurePx(prefs(1, 18, MAX_MEASURE)))
  })
})
