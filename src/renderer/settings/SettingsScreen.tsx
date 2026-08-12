import { createSignal, onCleanup, onMount, Show, For, type JSX } from 'solid-js'
import type { ServerInfo, ServerType, SyncState } from '@shared/ipc/protocol'

/**
 * Settings overlay (M7): remote servers, sync state, conflict resolution.
 * Secrets go to the keychain-backed store via the worker→main channel — the
 * form's secret field is only ever forwarded for the setup exchange.
 */

const SERVER_TYPES: readonly {
  id: ServerType
  label: string
  secretLabel: string
  username: boolean
}[] = [
  { id: 'komga', label: 'Komga', secretLabel: 'API key', username: false },
  { id: 'calibre-web', label: 'calibre-web', secretLabel: 'Password', username: true },
  { id: 'liseur-sync', label: 'liseur-sync', secretLabel: 'Password', username: true },
]

export function SettingsScreen(props: { onClose: () => void }): JSX.Element {
  const [resumeLastBook, setResumeLastBook] = createSignal(false)
  const [state, setState] = createSignal<SyncState | null>(null)
  const [addOpen, setAddOpen] = createSignal(false)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [testResults, setTestResults] = createSignal<Record<string, string>>({})
  const [statsFor, setStatsFor] = createSignal<string | null>(null)
  const [statsPassword, setStatsPassword] = createSignal('')
  const [statsError, setStatsError] = createSignal<string | null>(null)

  // form fields
  const [formType, setFormType] = createSignal<ServerType>('komga')
  const [formName, setFormName] = createSignal('')
  const [formUrl, setFormUrl] = createSignal('')
  const [formUsername, setFormUsername] = createSignal('')
  const [formSecret, setFormSecret] = createSignal('')
  const [formError, setFormError] = createSignal<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      setState(await window.liseur.sync.getState())
    } catch (err) {
      console.error('sync state failed', err)
    }
  }

  onMount(() => {
    void refresh()
    const off = window.liseur.sync.onStateChanged((s) => setState(s))
    onCleanup(off)
    void window.liseur.settings.get().then((s) => setResumeLastBook(s.resumeLastBook ?? false))
  })

  function updateResumeLastBook(checked: boolean): void {
    setResumeLastBook(checked)
    void window.liseur.settings.set({ resumeLastBook: checked })
  }

  async function shareStats(e: Event, serverId: string): Promise<void> {
    e.preventDefault()
    setStatsError(null)
    setBusy(serverId)
    try {
      const result = await window.liseur.sync.enableStats(serverId, statsPassword())
      if (!result.ok) {
        setStatsError(result.detail ?? 'the server would not grant it')
        return
      }
      setStatsFor(null)
      setStatsPassword('')
      await refresh()
    } catch (err) {
      setStatsError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function serverTypeMeta(type: ServerType) {
    return SERVER_TYPES.find((t) => t.id === type) ?? SERVER_TYPES[0]!
  }

  async function addServer(e: Event): Promise<void> {
    e.preventDefault()
    setFormError(null)
    setBusy('add')
    try {
      const { server, test } = await window.liseur.sync.setupServer({
        type: formType(),
        name: formName() || formUrl(),
        url: formUrl(),
        ...(serverTypeMeta(formType()).username ? { username: formUsername() } : {}),
        secret: formSecret(),
      })
      if (!test.ok) {
        setFormError(test.detail ?? 'connection failed')
        await window.liseur.sync.removeServer(server.id)
        return
      }
      setAddOpen(false)
      setFormName('')
      setFormUrl('')
      setFormUsername('')
      setFormSecret('')
      await refresh()
    } catch (err) {
      setFormError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function testConnection(server: ServerInfo): Promise<void> {
    setBusy(server.id)
    try {
      const result = await window.liseur.sync.testConnection(server.id)
      setTestResults((m) => ({
        ...m,
        [server.id]: result.ok ? 'Connected ✓' : (result.detail ?? 'failed'),
      }))
    } finally {
      setBusy(null)
    }
  }

  async function syncNow(server: ServerInfo): Promise<void> {
    setBusy(server.id)
    try {
      await window.liseur.sync.syncNow(server.id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function removeServer(server: ServerInfo): Promise<void> {
    setBusy(server.id)
    try {
      await window.liseur.sync.removeServer(server.id)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function resolve(
    bookId: string,
    serverId: string,
    choice: 'local' | 'server',
  ): Promise<void> {
    await window.liseur.sync.resolveConflict(bookId, serverId, choice)
    await refresh()
  }

  return (
    <div class="settings-overlay" role="dialog" aria-label="Settings">
      <div class="settings-panel">
        <header class="settings-header">
          <h1>Settings</h1>
          <button
            type="button"
            class="icon-button"
            aria-label="Close settings"
            onClick={props.onClose}
          >
            ×
          </button>
        </header>

        <section class="settings-section">
          <h2>General</h2>
          <label class="settings-checkbox">
            <input
              type="checkbox"
              checked={resumeLastBook()}
              onChange={(e) => updateResumeLastBook(e.currentTarget.checked)}
            />
            Resume last opened book on launch
          </label>
        </section>

        <section class="settings-section">
          <h2>Remote servers</h2>
          <p class="settings-hint">
            Sync status: {state()?.syncing ? 'syncing…' : 'idle'} · {state()?.queueSize ?? 0} queued
          </p>
          <Show when={state()?.lastError}>
            {(err) => (
              <p class="settings-error" role="status">
                Last sync failed: {err()}
              </p>
            )}
          </Show>

          <For each={state()?.servers ?? []}>
            {(server) => (
              <div class="server-row" data-server={server.id}>
                <div class="server-info">
                  <span class="server-name">{server.name}</span>
                  <span class="server-detail">
                    {server.type} · {server.url}
                    {server.hasCredentials ? '' : ' · ⚠ no credentials'}
                    {server.lastSyncAt
                      ? ` · synced ${new Date(server.lastSyncAt).toLocaleString()}`
                      : ''}
                  </span>
                  <Show when={server.type === 'liseur-sync' && !server.sharesStats}>
                    <span class="server-detail">
                      Statistics are not shared with this server, so reading totals only count this
                      computer.{' '}
                      <Show
                        when={statsFor() === server.id}
                        fallback={
                          <button
                            type="button"
                            class="link-button"
                            onClick={() => {
                              setStatsError(null)
                              setStatsPassword('')
                              setStatsFor(server.id)
                            }}
                          >
                            Share them
                          </button>
                        }
                      >
                        <form class="share-stats" onSubmit={(e) => void shareStats(e, server.id)}>
                          <input
                            type="password"
                            placeholder="Password"
                            autocomplete="current-password"
                            value={statsPassword()}
                            onInput={(e) => setStatsPassword(e.currentTarget.value)}
                          />
                          <button type="submit" disabled={busy() === server.id}>
                            {busy() === server.id ? 'Asking…' : 'Share'}
                          </button>
                          <button type="button" onClick={() => setStatsFor(null)}>
                            Cancel
                          </button>
                        </form>
                        <Show when={statsError()}>
                          <span class="settings-error">{statsError()}</span>
                        </Show>
                      </Show>
                    </span>
                  </Show>
                  <Show when={testResults()[server.id]}>
                    <span class="server-test-result">{testResults()[server.id]}</span>
                  </Show>
                </div>
                <div class="server-actions">
                  <button
                    type="button"
                    disabled={busy() === server.id}
                    onClick={() => void testConnection(server)}
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    disabled={busy() === server.id}
                    onClick={() => void syncNow(server)}
                  >
                    Sync now
                  </button>
                  <button
                    type="button"
                    class="danger"
                    disabled={busy() === server.id}
                    onClick={() => void removeServer(server)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </For>

          <Show
            when={addOpen()}
            fallback={
              <button type="button" class="add-server" onClick={() => setAddOpen(true)}>
                + Add server
              </button>
            }
          >
            <form class="add-server-form" onSubmit={(e) => void addServer(e)}>
              <div class="form-row">
                <label for="server-type">Type</label>
                <select
                  id="server-type"
                  value={formType()}
                  onChange={(e) => setFormType(e.currentTarget.value as ServerType)}
                >
                  <For each={SERVER_TYPES}>{(t) => <option value={t.id}>{t.label}</option>}</For>
                </select>
              </div>
              <div class="form-row">
                <label for="server-name">Name</label>
                <input
                  id="server-name"
                  value={formName()}
                  onInput={(e) => setFormName(e.currentTarget.value)}
                  placeholder="My server"
                />
              </div>
              <div class="form-row">
                <label for="server-url">URL</label>
                <input
                  id="server-url"
                  required
                  type="url"
                  value={formUrl()}
                  onInput={(e) => setFormUrl(e.currentTarget.value)}
                  placeholder="https://books.example.com"
                />
              </div>
              <Show when={serverTypeMeta(formType()).username}>
                <div class="form-row">
                  <label for="server-username">Username</label>
                  <input
                    id="server-username"
                    value={formUsername()}
                    onInput={(e) => setFormUsername(e.currentTarget.value)}
                  />
                </div>
              </Show>
              <div class="form-row">
                <label for="server-secret">{serverTypeMeta(formType()).secretLabel}</label>
                <input
                  id="server-secret"
                  required
                  type="password"
                  value={formSecret()}
                  onInput={(e) => setFormSecret(e.currentTarget.value)}
                />
              </div>
              <Show when={formError()}>
                <p class="form-error" role="alert">
                  {formError()}
                </p>
              </Show>
              <div class="form-actions">
                <button type="submit" disabled={busy() === 'add'}>
                  {busy() === 'add' ? 'Connecting…' : 'Add & test'}
                </button>
                <button type="button" onClick={() => setAddOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </Show>
        </section>

        <Show when={(state()?.conflicts.length ?? 0) > 0}>
          <section class="settings-section">
            <h2>Sync conflicts</h2>
            <For each={state()?.conflicts ?? []}>
              {(conflict) => (
                <div class="conflict-row">
                  <span class="conflict-book">{conflict.bookTitle}</span>
                  <span class="conflict-detail">
                    here {Math.round((conflict.localProgression ?? 0) * 100)}% ·{' '}
                    {conflict.serverName} {Math.round((conflict.remoteProgression ?? 0) * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => void resolve(conflict.bookId, conflict.serverId, 'local')}
                  >
                    Use this device
                  </button>
                  <button
                    type="button"
                    onClick={() => void resolve(conflict.bookId, conflict.serverId, 'server')}
                  >
                    Use server
                  </button>
                </div>
              )}
            </For>
          </section>
        </Show>
      </div>
    </div>
  )
}
