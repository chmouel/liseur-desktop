/**
 * Minimal HTTP layer for sync. Runs in the worker only (never renderer/main).
 * `fetch` is injectable for tests. Timeouts are mandatory: a dead server must
 * never hang a sync run. Never throws on non-2xx — returns a typed result so
 * callers handle auth/expiry explicitly.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Headers
  json<T>(): Promise<T>
  text(): Promise<string>
  /** Streamed read with a hard byte cap — untrusted servers can't exhaust
   *  worker memory with an unbounded body. */
  bytes(limit?: number): Promise<Buffer>
}

export interface HttpResult<T> {
  ok: boolean
  status: number
  value?: T
  error?: string
}

export class Http {
  constructor(
    private readonly baseUrl: string,
    /** Prebuilt auth headers (main computes them; secrets never enter the worker). */
    private readonly authHeaders: Record<string, string> = {},
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  url(path: string): string {
    // Absolute URLs (e.g. OPDS acquisition hrefs) pass through unchanged.
    if (path.startsWith('http://') || path.startsWith('https://')) return path
    return `${this.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  }

  /** Auth headers only ever go to the configured server origin — a malicious
   *  catalog must not be able to exfiltrate credentials via absolute URLs. */
  private isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin
    } catch {
      return false
    }
  }

  async request(
    method: string,
    path: string,
    options: { body?: BodyInit; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<HttpResult<HttpResponse>> {
    // Manual redirect following: `follow` would forward Authorization to a
    // cross-origin Location. Redirects are followed only same-origin, with
    // auth headers re-evaluated per hop.
    const maxRedirects = 5
    let target = this.url(path)
    let currentMethod = method
    let currentBody = options.body ?? null

    for (let hop = 0; ; hop++) {
      const controller = new AbortController()
      // The timer covers the WHOLE exchange, including streaming the body
      // (cleared by the body readers below, not when headers arrive).
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs)
      try {
        const headers: Record<string, string> = {
          ...(this.isSameOrigin(target) ? this.authHeaders : {}),
          ...options.headers,
        }
        const response = await this.fetchImpl(target, {
          method: currentMethod,
          headers,
          body: currentBody,
          signal: controller.signal,
          redirect: 'manual',
        })

        if ([301, 302, 303, 307, 308].includes(response.status) && hop < maxRedirects) {
          const location = response.headers.get('location')
          clearTimeout(timer)
          if (!location) {
            return { ok: false, status: response.status, error: 'redirect without location' }
          }
          const next = new URL(location, target).toString()
          // Cross-origin redirect of a SENSITIVE request: refuse. Covers
          // configured auth headers, per-request cookie/auth headers (the
          // Calibre login flow), and any body (a login POST's password must
          // never leave the configured origin).
          const optionHeaders = Object.keys(options.headers ?? {})
          const sensitive =
            Object.keys(this.authHeaders).length > 0 ||
            options.body != null ||
            optionHeaders.some((h) =>
              ['cookie', 'authorization', 'x-api-key', 'proxy-authorization'].includes(
                h.toLowerCase(),
              ),
            )
          if (sensitive && !this.isSameOrigin(next)) {
            return { ok: false, status: response.status, error: 'cross-origin redirect refused' }
          }
          target = next
          // Standard redirect semantics: 301/302/303 turn POST into GET.
          if (response.status !== 307 && response.status !== 308 && currentMethod !== 'GET') {
            currentMethod = 'GET'
            currentBody = null
          }
          continue
        }

        const finish = () => clearTimeout(timer)
        // Bodyless responses (204, 304, HEAD) will never be read: release
        // the timer immediately instead of lingering until timeout.
        if (response.body === null) finish()
        return {
          ok: response.ok,
          status: response.status,
          value: {
            status: response.status,
            ok: response.ok,
            headers: response.headers,
            json: async <T>() => {
              try {
                return (await response.json()) as T
              } finally {
                finish()
              }
            },
            text: async () => {
              try {
                return await response.text()
              } finally {
                finish()
              }
            },
            bytes: async (limit = 512 * 1024 * 1024) => {
              try {
                const declared = Number(response.headers.get('content-length') ?? 0)
                if (declared > limit) {
                  throw new Error(`response too large: ${declared} bytes (limit ${limit})`)
                }
                const reader = response.body?.getReader()
                if (!reader) return Buffer.from(await response.arrayBuffer())
                const chunks: Uint8Array[] = []
                let total = 0
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  total += value.length
                  if (total > limit) {
                    await reader.cancel()
                    throw new Error(`response exceeds limit of ${limit} bytes`)
                  }
                  chunks.push(value)
                }
                return Buffer.concat(chunks)
              } finally {
                finish()
              }
            },
          },
        }
      } catch (err) {
        clearTimeout(timer)
        return { ok: false, status: 0, error: (err as Error).message }
      }
    }
  }

  async getJson<T>(path: string): Promise<HttpResult<T>> {
    const res = await this.request('GET', path)
    if (!res.ok || !res.value) {
      return { ok: false, status: res.status, error: res.error ?? `HTTP ${res.status}` }
    }
    try {
      return { ok: true, status: res.status, value: await res.value.json<T>() }
    } catch (err) {
      return { ok: false, status: res.status, error: `invalid JSON: ${(err as Error).message}` }
    }
  }
}

/** Builds the auth header map for a server type. Runs in MAIN (secrets). */
export function authHeadersFor(
  kind: 'basic' | 'apikey' | 'bearer',
  value: string,
  username?: string,
): Record<string, string> {
  switch (kind) {
    case 'basic':
      return {
        authorization: `Basic ${Buffer.from(`${username ?? ''}:${value}`).toString('base64')}`,
      }
    case 'bearer':
      return { authorization: `Bearer ${value}` }
    case 'apikey':
      return { 'x-api-key': value }
  }
}
