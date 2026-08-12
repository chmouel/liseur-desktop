import { createHash } from 'node:crypto'
import type { Locator } from '../../shared/domain/types'
import { Http, type HttpResponse, type HttpResult } from './http'
import type {
  ProgressRecord,
  PullResult,
  RemoteBook,
  RemoteCatalog,
  RemoteReadingSession,
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

/** What the server knows about reading done on every device, not just this one. */
export interface InsightsSummary {
  rangeDays: number
  totalMs: number
  sessions: number
  streakDays: number
}

/** One book's lifetime total, as every device together has read it. */
export interface WorkInsights {
  sessions: number
  totalMs: number
  lastReadAt?: number
}

/** Minutes arrive as numbers the server computed; a NaN is worth nothing. */
function numberOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export class LiseurSyncCatalog implements RemoteCatalog {
  private readonly http: Http
  /**
   * Statistics are read with their own narrower credential, because the
   * server refuses them to a sync token on purpose. Without one, every
   * insights call here answers null and the screen keeps its local figures.
   */
  private readonly insightsHttp: Http | null

  constructor(
    readonly server: RemoteServer,
    authHeaders: Record<string, string>,
    fetchImpl?: ConstructorParameters<typeof Http>[2],
    insightsToken?: string,
  ) {
    this.http = new Http(server.url, authHeaders, fetchImpl)
    this.insightsHttp = insightsToken
      ? new Http(server.url, { authorization: `Bearer ${insightsToken}` }, fetchImpl)
      : null
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
   * Uploads finished reading stretches, which is what the server counts
   * into the reading statistics. Positions say where you are; these say
   * that you were there for a while.
   *
   * The batch either lands or is retried whole on the next sync: the server
   * keys sessions by their id, so resending one already stored changes
   * nothing.
   */
  async pushSessions(sessions: RemoteReadingSession[]): Promise<boolean> {
    if (sessions.length === 0) return true
    const res = await this.http.request('POST', '/v1/sessions', {
      body: JSON.stringify({
        sessions: sessions.map((session) => ({
          session_id: session.id,
          work_id: session.workId,
          started_at: new Date(session.startedAt).toISOString(),
          ended_at: new Date(session.endedAt).toISOString(),
          start_progression: session.startProgression ?? 0,
          end_progression: session.endProgression ?? session.startProgression ?? 0,
        })),
      }),
      headers: { 'content-type': 'application/json' },
    })
    return res.ok
  }

  /**
   * The server's own count of reading done, across every device signed in.
   * This machine only knows what was read on it; the phone's mornings are
   * only in the server's figures.
   *
   * A summary with nothing in it is treated as no answer: a server that has
   * never been told about this reader should not blank out figures this
   * machine can prove.
   */
  async fetchInsightsSummary(rangeDays = 30): Promise<InsightsSummary | null> {
    if (!this.insightsHttp) return null
    const res = await this.insightsHttp.getJson<{
      range_days?: number
      total_active_minutes?: number
      sessions?: number
      streak_days?: number
    }>(`/v1/insights/summary?range=${rangeDays}d`)
    if (!res.ok || !res.value) return null
    const minutes = numberOrZero(res.value.total_active_minutes)
    const sessions = res.value.sessions ?? 0
    if (minutes <= 0 && sessions <= 0) return null
    return {
      rangeDays: res.value.range_days ?? rangeDays,
      totalMs: Math.round(minutes * 60_000),
      sessions,
      streakDays: res.value.streak_days ?? 0,
    }
  }

  /**
   * Minutes per calendar day, in the timezone the server keeps for this
   * reader. Days outside `from`..`to` are dropped; days inside it that the
   * server does not mention were simply not read on.
   */
  async fetchInsightsCalendar(from: string, to: string): Promise<Map<string, number> | null> {
    if (!this.insightsHttp) return null
    const years = new Set([from.slice(0, 4), to.slice(0, 4)])
    const byDay = new Map<string, number>()
    for (const year of years) {
      const res = await this.insightsHttp.getJson<{
        days?: Array<{ date?: string; minutes?: number }>
      }>(`/v1/insights/calendar?year=${encodeURIComponent(year)}`)
      if (!res.ok || !res.value) return null
      for (const day of res.value.days ?? []) {
        if (!day.date || day.date < from || day.date > to) continue
        byDay.set(day.date, Math.round(numberOrZero(day.minutes) * 60_000))
      }
    }
    return byDay
  }

  /** Lifetime per-book totals, keyed by the server's work id. */
  async fetchInsightsWorks(): Promise<Map<string, WorkInsights> | null> {
    if (!this.insightsHttp) return null
    const res = await this.insightsHttp.getJson<{
      works?: Array<{
        work_id?: string
        sessions?: number
        total_active_minutes?: number
        last_read_at?: string
      }>
    }>('/v1/insights/works')
    if (!res.ok || !res.value) return null
    const byWork = new Map<string, WorkInsights>()
    for (const work of res.value.works ?? []) {
      if (!work.work_id) continue
      const lastReadAt = work.last_read_at ? Date.parse(work.last_read_at) : Number.NaN
      byWork.set(work.work_id, {
        sessions: work.sessions ?? 0,
        totalMs: Math.round(numberOrZero(work.total_active_minutes) * 60_000),
        ...(Number.isFinite(lastReadAt) ? { lastReadAt } : {}),
      })
    }
    return byWork
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

/**
 * Setup flow: sign in, then mint a scoped device token to keep (returned to
 * the caller, which stores it via the OS-keychain-backed secret store in
 * main). The password buys an hour-long credential that can do nothing but
 * create device tokens, and is never stored.
 *
 * Returns the reason on failure. "Login failed" on its own tells a user
 * nothing about whether they typed the wrong password, pointed at the wrong
 * URL, or hit a server that is down.
 */
export async function liseurSyncLogin(
  serverUrl: string,
  username: string,
  password: string,
  fetchImpl?: ConstructorParameters<typeof Http>[2],
): Promise<{ ok: true; token: string; insightsToken?: string } | { ok: false; detail: string }> {
  const http = new Http(serverUrl, {}, fetchImpl)
  const login = await http.request('POST', '/v1/login', {
    body: JSON.stringify({ username, password }),
    headers: { 'content-type': 'application/json' },
  })
  if (!login.ok || !login.value) return { ok: false, detail: await describe('sign-in', login) }
  const session = await login.value.json<{ auth_token?: string }>()
  if (!session.auth_token) {
    return { ok: false, detail: 'sign-in answered without a credential' }
  }

  const mintWith = new Http(
    serverUrl,
    { authorization: `Bearer ${session.auth_token}` },
    fetchImpl,
  )
  const mint = await mintWith.request('POST', '/v1/tokens', {
    body: JSON.stringify({ name: 'liseur-desktop', scope: 'sync' }),
    headers: { 'content-type': 'application/json' },
  })
  if (!mint.ok || !mint.value) return { ok: false, detail: await describe('device token', mint) }
  // The server shows the device secret exactly once, as `secret`
  // (internal/api/routes.go, HandleCreateToken). `token` is accepted too so
  // an older server is not left stranded.
  const data = await mint.value.json<{ secret?: string; token?: string }>()
  const token = data.secret ?? data.token
  if (!token) return { ok: false, detail: 'device token came back empty' }

  // A second, narrower credential for reading statistics. The sync token is
  // refused by those routes on purpose, and a server that will not grant the
  // scope still syncs positions perfectly well, so a refusal here is stepped
  // over rather than failing the whole setup.
  let insightsToken: string | undefined
  try {
    const stats = await mintWith.request('POST', '/v1/tokens', {
      body: JSON.stringify({ name: 'liseur-desktop (statistics)', scope: 'read-insights' }),
      headers: { 'content-type': 'application/json' },
    })
    if (stats.ok && stats.value) {
      const minted = await stats.value.json<{ secret?: string; token?: string }>()
      insightsToken = minted.secret ?? minted.token
    }
  } catch {
    // No statistics token; positions still sync.
  }

  return { ok: true, token, ...(insightsToken ? { insightsToken } : {}) }
}

/** Turns a refused request into something worth showing a person. */
async function describe(what: string, result: HttpResult<HttpResponse>): Promise<string> {
  if (!result.value) return `${what} failed: ${result.error ?? `HTTP ${result.status}`}`
  let body = ''
  try {
    body = (await result.value.text()).trim().slice(0, 200)
  } catch {
    // A server that will not even give us its complaint still has a status.
  }
  const parsed = ((): string => {
    try {
      return String((JSON.parse(body) as { error?: unknown }).error ?? '')
    } catch {
      return body
    }
  })()
  return `${what} failed: HTTP ${result.status}${parsed ? ` — ${parsed}` : ''}`
}
