import { app, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Bundled reading fonts, available only to the sandboxed book iframe. */
export const FONT_SCHEME = 'liseur-font'

const FONT_FILES: Record<string, string> = {
  roman: 'Literata[opsz,wght].ttf',
  italic: 'Literata-Italic[opsz,wght].ttf',
}

function fontsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'fonts')
    : join(app.getAppPath(), 'src/renderer/assets/fonts')
}

/** Must run after app ready. Streams a fixed allowlist, never a user path. */
export function handleFontRequests(): void {
  protocol.handle(FONT_SCHEME, (request) => {
    const url = new URL(request.url)
    const name = url.host === 'font' ? FONT_FILES[url.pathname.replace(/^\//, '')] : undefined
    if (!name) return new Response('not found', { status: 404 })

    return net.fetch(pathToFileURL(join(fontsDir(), name)).toString()).then((response) => {
      const headers = new Headers(response.headers)
      headers.set('content-type', 'font/ttf')
      headers.set('access-control-allow-origin', '*')
      return new Response(response.body, { status: response.status, headers })
    })
  })
}
