import { createHash } from 'node:crypto'
import type { Locator } from '../../shared/domain/types'
import { Http } from './http'
import type {
  ProgressRecord,
  PullResult,
  RemoteBook,
  RemoteCatalog,
  RemoteServer,
  TestResult,
} from './types'

/**
 * liseur-sync: the sync-first companion server (no catalog — it syncs
 * progress and reading sessions for books obtained elsewhere). Mirrors the
 * Android client (data/liseursync/*): bearer token minted at setup, ops push
 * via POST /v1/ops, catch-up pull via GET /v1/changes (410 → resync from
 * /v1/heads), works resolved via POST /v1/works/resolve.
 *
 * Endpoint shapes are implemented to the same contract the Android app uses;
 * any mismatch shows up in the mocked unit tests first, real-server testing
 * second (documented in DESIGN.md).
 */

export interface LiseurSyncOp {
  op_id: string
  work_id: string
  edition_sha?: string
  client_ts: string
  progression?: number
  locator?: Locator
  device_id?: string
  seq?: number
}

/** Deterministic op ids give idempotent retries (server returns duplicate). */
export function makeOpId(deviceId: string, workId: string, updatedAt: number): string {
  return createHash('sha256')
    .update(`${deviceId}:${workId}:${updatedAt}`)
    .digest('hex')
    .slice(0, 32)
}

export class LiseurSyncCatalog implements RemoteCatalog {
  private readonly http: Http

  constructor(
    readonly server: RemoteServer,
    authHeaders: Record<string, string>,
    fetchImpl?: ConstructorParameters<typeof Http>[2],
  ) {
    this.http = new Http(server.url, authHeaders, fetchImpl)
  }

  async testConnection(): Promise<TestResult> {
    // The Android app validates tokens against the changes endpoint.
    const res = await this.http.getJson<{ high_water?: number | string }>(
      '/v1/changes?since=0&limit=1',
    )
    if (res.status === 401 || res.status === 403) return { ok: false, detail: 'invalid token' }
    if (!res.ok) return { ok: false, detail: res.error ?? `HTTP ${res.status}` }
    if (res.value?.high_water === undefined)
      return { ok: false, detail: 'not a liseur-sync server' }
    return { ok: true }
  }

  // No catalog capability: liseur-sync is progress sync only.
  async *listBooks(): AsyncIterable<RemoteBook[]> {
    if (false as boolean) yield [] // never; satisfies the async-iterable contract
  }

  async download(): Promise<Buffer> {
    throw new Error('liseur-sync has no catalog downloads')
  }

  async fetchCover(): Promise<Buffer | null> {
    return null
  }

  /** Resolves a local book to a server work id by content hash/title. */
  async resolveWorkId(input: {
    editionSha?: string | undefined
    title: string
    authors: string[]
  }): Promise<string | null> {
    const res = await this.http.request('POST', '/v1/works/resolve', {
      body: JSON.stringify({
        edition_sha: input.editionSha,
        title: input.title,
        authors: input.authors,
      }),
      headers: { 'content-type': 'application/json' },
    })
    if (!res.ok || !res.value) return null
    const data = await res.value.json<{ work_id?: string }>()
    return data.work_id ?? null
  }

  async pullProgress(workId: string): Promise<PullResult> {
    const res = await this.http.getJson<{ ops?: LiseurSyncOp[] }>(
      `/v1/works/${encodeURIComponent(workId)}/positions?limit=1`,
    )
    if (!res.ok) return { status: 'error', detail: res.error ?? `HTTP ${res.status}` }
    const op = res.value?.ops?.[0]
    if (!op) return { status: 'missing' }
    return {
      status: 'ok',
      record: {
        progression: op.progression,
        locator: op.locator,
        updatedAt: Date.parse(op.client_ts) || undefined,
      },
    }
  }

  /**
   * Resync entry point after a 410: the heads snapshot carries the current
   * ops plus the cursor to resume from (`snapshot_seq`; `high_water` accepted
   * as a legacy alias).
   */
  async heads(): Promise<{ ops: LiseurSyncOp[]; cursor: string } | null> {
    const res = await this.http.getJson<{
      ops?: LiseurSyncOp[]
      snapshot_seq?: string | number
      high_water?: string | number
    }>('/v1/heads')
    if (!res.ok || !res.value) return null
    const cursor = res.value.snapshot_seq ?? res.value.high_water
    if (cursor === undefined) return null
    return { ops: res.value.ops ?? [], cursor: String(cursor) }
  }

  async pushProgress(
    workId: string,
    progress: ProgressRecord,
  ): Promise<'ok' | 'stale' | 'rejected'> {
    const at = progress.updatedAt ?? Date.now()
    const op: LiseurSyncOp = {
      op_id: makeOpId('liseur-desktop', workId, at),
      work_id: workId,
      client_ts: new Date(at).toISOString(),
    }
    if (progress.progression !== undefined) op.progression = progress.progression
    // The server drops invalid/oversized locators; send only sane ones.
    if (progress.locator && JSON.stringify(progress.locator).length <= 16 * 1024) {
      op.locator = progress.locator
    }
    const res = await this.http.request('POST', '/v1/ops', {
      body: JSON.stringify({ ops: [op] }),
      headers: { 'content-type': 'application/json' },
    })
    if (!res.ok || !res.value) return res.status === 409 ? 'stale' : 'rejected'
    const data = await res.value.json<{ results?: { op_id: string; status: string }[] }>()
    const status = data.results?.[0]?.status
    return status === 'applied' || status === 'duplicate' ? 'ok' : 'rejected'
  }

  /**
   * Catch-up pull of changes since a cursor. Returns the new cursor
   * (high_water) and changed work ids; 410 means the cursor is too old and
   * the caller must resync from heads.
   */
  async pullChanges(
    since: string,
    limit = 500,
  ): Promise<{ ops: LiseurSyncOp[]; highWater: string; hasMore: boolean } | 'resync' | null> {
    const res = await this.http.getJson<{
      ops?: LiseurSyncOp[]
      high_water?: string | number
      has_more?: boolean
    }>(`/v1/changes?since=${encodeURIComponent(since)}&limit=${limit}`)
    if (res.status === 410) return 'resync'
    if (!res.ok || !res.value) return null
    return {
      ops: res.value.ops ?? [],
      highWater: String(res.value.high_water ?? since),
      hasMore: res.value.has_more ?? false,
    }
  }
}

/** Setup flow: login → mint a scoped sync token (returned to the caller, which
 *  stores it via the OS-keychain-backed secret store in main). */
export async function liseurSyncLogin(
  serverUrl: string,
  username: string,
  password: string,
  fetchImpl?: ConstructorParameters<typeof Http>[2],
): Promise<{ token: string } | null> {
  const http = new Http(serverUrl, {}, fetchImpl)
  const login = await http.request('POST', '/v1/login', {
    body: JSON.stringify({ username, password }),
    headers: { 'content-type': 'application/json' },
  })
  if (!login.ok || !login.value) return null
  const session = await login.value.json<{ auth_token?: string }>()
  if (!session.auth_token) return null

  const mint = await new Http(
    serverUrl,
    { authorization: `Bearer ${session.auth_token}` },
    fetchImpl,
  ).request('POST', '/v1/tokens', {
    body: JSON.stringify({ scope: 'sync', name: 'liseur-desktop' }),
    headers: { 'content-type': 'application/json' },
  })
  if (!mint.ok || !mint.value) return null
  const data = await mint.value.json<{
    token?: string
    tokens?: { token: string; scope: string }[]
  }>()
  const token = data.token ?? data.tokens?.find((t) => t.scope === 'sync')?.token
  return token ? { token } : null
}
