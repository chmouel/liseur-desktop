import type { ReaderPreferences } from '../../shared/domain/types'

/**
 * The stylesheet injected into the book document. Injection is a plain
 * <style> element: no DOM surgery, no animation, and typography changes
 * re-layout instantly.
 *
 * The page is always paper white with black ink — there is no reader theme.
 */

/** The book page. The reader chrome uses the same white, so it reads as one surface. */
export const READER_BACKGROUND = '#ffffff'
export const READER_TEXT = '#1a1a1a'

/** Gutter between side-by-side columns; without it the two texts collide. */
const COLUMN_GAP_PX = 48

/**
 * Gutter for a given column count. A single column needs none (the gap would
 * only ever fall between two pages, off screen), so single-column layout
 * keeps the simplest possible page arithmetic.
 */
export function columnGapFor(columns: number): number {
  return columns > 1 ? COLUMN_GAP_PX : 0
}

/**
 * Comfortable line length, in multiples of the font size. 34em keeps the
 * page intimate at the default 20px size — roughly 65 characters per line.
 * Wider than this and the eye loses the line on the way back.
 */
export const DEFAULT_MEASURE = 34

/**
 * Margin presets, as the measure each one leaves for the text. Narrow
 * margins give the text more room, so they are the largest number.
 *
 * The bounds are deliberately not symmetric around the default: 20em is
 * about 40 characters, which is as narrow as prose stays readable, while
 * 60em is wide enough to fill a large screen for anyone who prefers
 * fewer page turns to a classic measure.
 */
export const MARGIN_PRESETS = { wide: 28, normal: DEFAULT_MEASURE, narrow: 46 } as const
export type MarginPreset = keyof typeof MARGIN_PRESETS

export const MIN_MEASURE = 20
export const MAX_MEASURE = 60

export function clampMeasure(measure: number): number {
  if (!Number.isFinite(measure)) return DEFAULT_MEASURE
  return Math.min(MAX_MEASURE, Math.max(MIN_MEASURE, Math.round(measure)))
}

/** The preset a measure corresponds to, or undefined for a custom width. */
export function marginPresetFor(measure: number): MarginPreset | undefined {
  return (Object.keys(MARGIN_PRESETS) as MarginPreset[]).find(
    (name) => MARGIN_PRESETS[name] === measure,
  )
}

/** Horizontal padding of `.reader-viewport`, which sits outside the iframe. */
const VIEWPORT_PADDING_X = 48

/**
 * Font size bounds. The ceiling is set for low-vision reading rather than
 * for typography: at 96px a line holds only a handful of words, which is
 * exactly what someone who needs it is asking for.
 */
export const MIN_FONT_SIZE = 10
export const MAX_FONT_SIZE = 96

/** Starting size, and the fallback for a corrupt persisted value. */
export const DEFAULT_FONT_SIZE = 20

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))
}

/**
 * Widest the reader viewport may grow before the text stops being readable.
 * The cap lives outside the iframe (the container is what gets narrower), so
 * the column arithmetic inside is untouched — it always works off the
 * iframe's own width.
 */
export function readerMeasurePx(prefs: ReaderPreferences): number {
  const measure = clampMeasure(prefs.measure)
  const text = prefs.columns * measure * prefs.fontSize
  return text + (prefs.columns - 1) * columnGapFor(prefs.columns) + 2 * VIEWPORT_PADDING_X
}

/**
 * Builds the reader stylesheet. `pageWidth` is the iframe viewport width;
 * each page is `columns` columns plus their gutters wide, so one translateX
 * step is `pageWidth + gap` (the gutter after the last column of a page
 * falls outside the viewport). Horizontal breathing room comes from the
 * container *outside* the iframe, keeping column math exact.
 */
export function buildReaderCss(prefs: ReaderPreferences, pageWidth: number): string {
  const gap = columnGapFor(prefs.columns)
  const columnWidth = Math.max(
    80,
    Math.floor((pageWidth - (prefs.columns - 1) * gap) / prefs.columns),
  )
  return `
    @font-face {
      font-family: 'Liseur Literata';
      src: url('liseur-font://font/roman') format('truetype');
      font-style: normal;
      font-weight: 200 900;
      font-display: swap;
    }
    @font-face {
      font-family: 'Liseur Literata';
      src: url('liseur-font://font/italic') format('truetype');
      font-style: italic;
      font-weight: 200 900;
      font-display: swap;
    }
    html {
      margin: 0 !important; padding: 0 !important; border: 0 !important;
      height: 100%;
      overflow: hidden;
      background: ${READER_BACKGROUND};
      /* The reader's size lives on the root and everything inherits it, so
         one declaration drives the whole book. */
      font-size: ${prefs.fontSize}px;
    }
    html body {
      /* The column arithmetic assumes the multicol box is exactly as wide as
         the iframe, so the book must not shrink it. Publishers routinely do:
         Calibre puts \`margin: 0 5pt\` on every <body> it converts. A margin
         of even a few px makes each page turn overshoot, and the error
         accumulates until words are sliced off the edge. Breathing room comes
         from the container outside the iframe instead. */
      margin: 0 !important; padding: 0 !important; border: 0 !important;
      width: auto !important; max-width: none !important; min-width: 0 !important;
      height: 100vh;
      box-sizing: border-box;
      column-width: ${columnWidth}px;
      column-count: ${prefs.columns};
      column-gap: ${gap}px;
      column-fill: auto;
      background: ${READER_BACKGROUND};
      color: ${READER_TEXT};
      font-family: 'Liseur Literata', Georgia, serif !important;
      font-optical-sizing: auto;
      font-variant-ligatures: common-ligatures contextual;
      font-feature-settings: 'liga' 1, 'clig' 1, 'calt' 1;
      line-height: 1.6;
      overflow-wrap: break-word;
      /* Page turns are transform-only; must not animate (reflow rule). */
      transition: none;
      will-change: transform;
    }
    /* The reader's font size has to win, or it does nothing at all on most
       books: publishers pin their text with *absolute* sizes (font-size:
       small, 11px, 9pt), and absolute sizes are computed from the
       browser's default — they ignore the page's own font size entirely.
       Sizes that carry meaning (headings, small print, sub/sup) are restated
       in em, so the hierarchy survives at every reader size. */
    body, p, div, span, li, dd, dt, table, tr, td, th, blockquote, section,
    article, aside, main, header, footer, figure, figcaption, a, em, strong,
    i, b, u, s, cite, q, abbr, label, address, pre, code, ins, del, mark {
      font-size: inherit !important;
      font-family: inherit !important;
    }
    h1 { font-size: 1.8em !important; }
    h2 { font-size: 1.5em !important; }
    h3 { font-size: 1.3em !important; }
    h4 { font-size: 1.15em !important; }
    h5 { font-size: 1.05em !important; }
    h6 { font-size: 1em !important; }
    small, sub, sup { font-size: 0.8em !important; }
    img, svg, video { max-width: 100%; max-height: 92vh; object-fit: contain; }
    /* Only real links get link styling: EPUBs are full of empty <a id="page_42"/>
       markers, and underlining those would underline the text around them. */
    a[href] { color: inherit; text-decoration: underline; }
    /* Highlights (M6): CSS Custom Highlight API, no DOM mutation. Colors are
       translucent so highlighted text stays readable. */
    ::highlight(liseur-hl-yellow) { background-color: rgb(255 238 120 / 0.5); }
    ::highlight(liseur-hl-green) { background-color: rgb(140 215 140 / 0.5); }
    ::highlight(liseur-hl-blue) { background-color: rgb(130 185 250 / 0.55); }
    ::highlight(liseur-hl-pink) { background-color: rgb(250 165 195 / 0.5); }
    ::highlight(liseur-flash) { background-color: rgb(255 180 60 / 0.55); }
    /* Book CSS may set its own colors; ours win on the body only so the
       publisher's typography survives inside chapters. */
  `
}

/** Injects base URL + reader stylesheet into a loaded chapter document. */
export function injectReaderAssets(
  doc: Document,
  baseUrl: string,
  itemDir: string,
  prefs: ReaderPreferences,
  pageWidth: number,
): void {
  const head = doc.head ?? doc.documentElement
  // renderMarkup already text-injects <base> (it must exist at parse time);
  // add one only if the markup had no <head>/<html> to inject into.
  if (!doc.querySelector('base')) {
    const base = doc.createElement('base')
    base.href = `${baseUrl}${itemDir ? `${itemDir}/` : ''}`
    head.prepend(base)
  }

  let style = doc.getElementById('liseur-reader-css') as HTMLStyleElement | null
  if (!style) {
    style = doc.createElement('style')
    style.id = 'liseur-reader-css'
    head.appendChild(style)
  }
  style.textContent = buildReaderCss(prefs, pageWidth)
}

/** Directory of a spine item's href ('' for root) — base for relative URLs. */
export function itemDirOf(href: string): string {
  const slash = href.lastIndexOf('/')
  return slash === -1 ? '' : href.slice(0, slash)
}
