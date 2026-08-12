import type { ReaderPreferences, ReaderTheme } from '../../shared/domain/types'

/**
 * Reader themes (independent of the app theme — see DESIGN.md branding) and
 * the stylesheet injected into the book document. Injection is a plain
 * <style> element: no DOM surgery, no animation, and typography changes
 * re-layout instantly.
 */

export const READER_THEMES: Record<ReaderTheme, { background: string; color: string }> = {
  light: { background: '#FFFFFF', color: '#1A1A1A' },
  sepia: { background: '#F6EFDF', color: '#3D3229' },
  dark: { background: '#1F1F1F', color: '#CECECE' },
  black: { background: '#000000', color: '#B8B8B8' },
}

export const READER_THEME_ORDER: readonly ReaderTheme[] = ['light', 'sepia', 'dark', 'black']

/**
 * Builds the reader stylesheet. `pageWidth` is the iframe viewport width;
 * each page is `columns` columns wide so one translateX step is exactly one
 * screenful. Horizontal breathing room comes from the container *outside*
 * the iframe, keeping column math exact.
 */
export function buildReaderCss(prefs: ReaderPreferences, pageWidth: number): string {
  const theme = READER_THEMES[prefs.theme]
  const columnWidth = Math.max(80, Math.floor(pageWidth / prefs.columns))
  return `
    html {
      margin: 0; padding: 0;
      height: 100%;
      overflow: hidden;
      background: ${theme.background};
    }
    body {
      margin: 0; padding: 0;
      height: 100vh;
      box-sizing: border-box;
      column-width: ${columnWidth}px;
      column-gap: 0;
      column-fill: auto;
      background: ${theme.background};
      color: ${theme.color};
      font-size: ${prefs.fontSize}px;
      line-height: 1.6;
      overflow-wrap: break-word;
      /* Page turns are transform-only; must not animate (reflow rule). */
      transition: none;
      will-change: transform;
    }
    img, svg, video { max-width: 100%; max-height: 92vh; object-fit: contain; }
    a { color: inherit; text-decoration: underline; }
    /* Highlights (M6): CSS Custom Highlight API, no DOM mutation. Colors are
       translucent so they read on all four reader themes. */
    ::highlight(liseur-hl-yellow) { background-color: rgb(255 238 120 / 0.5); }
    ::highlight(liseur-hl-green) { background-color: rgb(140 215 140 / 0.5); }
    ::highlight(liseur-hl-blue) { background-color: rgb(130 185 250 / 0.55); }
    ::highlight(liseur-hl-pink) { background-color: rgb(250 165 195 / 0.5); }
    ::highlight(liseur-flash) { background-color: rgb(255 180 60 / 0.55); }
    /* Book CSS may set its own colors; themes win on the body only so the
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
