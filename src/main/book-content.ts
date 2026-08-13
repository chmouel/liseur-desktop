import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { join, normalize, extname, sep } from 'node:path'
import { dataDir } from './paths'

/**
 * Serves extracted book content to the reader's sandboxed iframe:
 * `liseur-epub://book/<bookId>/<path>`. The worker owns extraction
 * (`$LISEUR_DATA_DIR/extracted/<bookId>/`); main only streams files off
 * disk via Chromium's network stack — it never parses EPUB content.
 *
 * Book content is untrusted: every response carries a CSP that disables
 * scripts, and the iframe additionally runs sandboxed.
 */

export const BOOK_SCHEME = 'liseur-epub'

const CONTENT_TYPES: Record<string, string> = {
  '.xhtml': 'application/xhtml+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ncx': 'application/x-dtbncx+xml',
  '.opf': 'application/oebps-package+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
}

/** Must run after app ready. */
export function handleBookRequests(): void {
  protocol.handle(BOOK_SCHEME, (request) => {
    const notFound = () => new Response('not found', { status: 404 })
    const url = new URL(request.url)
    if (url.host !== 'book') return notFound()

    // Decode each segment defensively: malformed escapes, re-encoded
    // separators or dot segments are all rejected rather than normalized.
    let segments: string[]
    try {
      segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return notFound()
    }
    const [bookId, ...rest] = segments
    if (!bookId || rest.length === 0 || !/^[\w-]+$/.test(bookId)) return notFound()
    if (rest.some((s) => s.includes('/') || s.includes('\\') || s.includes('..'))) {
      return notFound()
    }

    const base = join(dataDir(), 'extracted', bookId)
    const path = normalize(join(base, ...rest))
    if (path !== base && !path.startsWith(base + sep)) return notFound()

    return net.fetch(pathToFileURL(path).toString()).then((response) => {
      const headers = new Headers(response.headers)
      headers.set(
        'content-type',
        CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      )
      // The renderer origin is file://; allow the reader's fetch().
      headers.set('access-control-allow-origin', '*')
      // Defense in depth: book markup must never execute scripts, even if it
      // is ever navigated outside the sandboxed reader iframe.
      headers.set('content-security-policy', "script-src 'none'; object-src 'none'")
      return new Response(response.body, { status: response.status, headers })
    })
  })
}
