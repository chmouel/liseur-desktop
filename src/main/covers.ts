import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { join, normalize, sep } from 'node:path'
import { coversDir } from './paths'

/**
 * Serves cached cover images to the renderer over a dedicated scheme
 * (`liseur-cover://cover/<id>`). This is pure static file serving streamed
 * by Chromium's network stack — main never parses or decodes images.
 * The worker owns cache writes; main only reads.
 */

export const COVER_SCHEME = 'liseur-cover'

/** Must run after app ready. */
export function handleCoverRequests(): void {
  protocol.handle(COVER_SCHEME, (request) => {
    const url = new URL(request.url)
    // Expect liseur-cover://cover/<id>; id is a worker-generated hash file
    // name. Reject anything trying to escape the covers directory.
    let id: string
    try {
      id = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (url.host !== 'cover' || !/^[\w.-]+$/.test(id) || id.includes('..') || id.includes('/')) {
      return new Response('not found', { status: 404 })
    }
    const base = coversDir()
    const path = normalize(join(base, id))
    if (path !== base && !path.startsWith(base + sep)) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(path).toString()).then((response) => {
      const headers = new Headers(response.headers)
      headers.set('access-control-allow-origin', '*')
      return new Response(response.body, { status: response.status, headers })
    })
  })
}
