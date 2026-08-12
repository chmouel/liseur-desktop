# Architecture

Liseur Desktop has three conceptual layers with hard boundaries between
them. The boundaries exist for one reason: **nothing expensive may ever
block the renderer or delay startup**.

```
┌──────────────────────────────────────────────────────────┐
│ Renderer (sandboxed Chromium, SolidJS)                   │
│   presentation + immediate interaction only              │
│      │  window.liseur.* (typed preload API)              │
│      │  ├─ settings/app: ipcRenderer.invoke ──► Main     │
│      │  └─ library: MessagePort ─────────────► Worker    │
├──────────────────────────────────────────────────────────┤
│ Main (Electron main process)                             │
│   lifecycle, windows, menu, port forwarding, settings    │
├──────────────────────────────────────────────────────────┤
│ Worker (Electron utilityProcess, isolated Node)          │
│   all expensive work: SQLite library, EPUB parsing,      │
│   scanning, search indexing, server sync                 │
└──────────────────────────────────────────────────────────┘
```

## Main process (`src/main/`)

- `main.ts` — app lifecycle, single-instance lock.
- `window.ts` — BrowserWindow creation: `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`; restores persisted bounds;
  blocks navigation, sends external links to the OS browser.
- `window-state.ts` — the ONLY sanctioned synchronous filesystem use in the
  app: a few hundred bytes of window bounds/settings, read once before the
  window exists; writes are debounced.
- `menu.ts` — native menu; menu actions are forwarded to the renderer.
- `ipc.ts` — port forwarding (renderer ↔ worker), settings get/set, theme.
- `worker-host.ts` — spawns and supervises the utilityProcess.

Main must never: parse EPUBs, run SQLite queries, scan directories, fetch
catalogs, extract covers, or index search.

## Renderer (`src/renderer/`)

- SolidJS; plain signals/stores; no state framework.
- `library/store.ts` — the search-field state is strictly local (same-frame
  typing); worker queries are debounced and stale results discarded via a
  generation counter.
- `library/VirtualBookGrid.tsx` + `virtualize.ts` — windowed rendering with
  overscan; adaptive column count via ResizeObserver; rAF-throttled scroll.
- `app/theme.ts` — app theme (system/light/dark) as a `data-theme`
  attribute; all colors flow through CSS variables.
- `perf/perf.ts` — dev-only timings + long-task observer.

## Worker (`src/worker/`)

Electron `utilityProcess.fork`. One process, one `LibraryService` per
connected renderer port. The library is backed by SQLite via Node's built-in
`node:sqlite` (`db/database.ts`, `db/migrations.ts`,
`library/book-repository.ts`) — no native dependency to rebuild against
Electron. The database lives at `$LISEUR_DATA_DIR/liseur.db`; main sets
`LISEUR_DATA_DIR` (default: `app.getPath('userData')`) when forking the
worker, since utilityProcess children cannot reach `app`. Unpackaged builds
seed an empty database with the deterministic fake dataset
(`library/seed.ts`, gated by `LISEUR_SEED_FAKE_LIBRARY`); packaged builds
start empty.

### EPUB ingestion

- `epub/zip.ts` — minimal read-only ZIP (stored/deflate via `node:zlib`);
  rejects encrypted, multi-disk and ZIP64 archives.
- `epub/xml.ts` — small tolerant XML scanner for container.xml/OPF (Node has
  no built-in XML parser; the worker has no DOM).
- `epub/epub.ts` — OPF metadata (title, creators, `dc:identifier`) and cover
  resolution (EPUB 3 `cover-image` property, EPUB 2 `<meta name="cover">`,
  first-image fallback). Engine-agnostic, independent of the reader
  implementation.
- `library/ingestion.ts` — hashing, duplicate detection (content hash, then
  OPF identifier), cover cache (content-addressed, write-once files under
  `$LISEUR_DATA_DIR/covers/`), recursive folder scans. Scans are async and
  yield between books so queries interleave; rescans stat-skip unchanged
  files. Added books stream to renderers as `bookAdded` events.
- Registered folders are rescanned when a renderer connects (not at worker
  boot, so events can't precede listeners). Main forwards dialog picks as
  typed control messages (`MainToWorkerMessage`); it never touches files.
- Covers reach the renderer via the `liseur-cover:` scheme
  (`main/covers.ts`): pure static file serving streamed by Chromium — no
  base64 over IPC, no image decode outside the renderer.

### Reader

- `library/open-book.ts` (worker) — opens a book: extracts the EPUB once
  into `$LISEUR_DATA_DIR/extracted/<bookId>/` (reused via an mtime+size
  marker), parses spine + TOC (EPUB 3 nav / EPUB 2 NCX), bumps
  `last_opened_at`. Progress upserts go through `BookRepository.setProgress`.
- `main/book-content.ts` — the `liseur-epub://book/<id>/<path>` scheme
  streams extracted files with per-extension content types and a
  `script-src 'none'` CSP. Registered `standard + secure + corsEnabled +
supportFetchAPI` so the renderer can `fetch()` chapter markup from its
  `file://` origin.
- `renderer/reader/engine.ts` — the `ReaderEngine` interface and
  `ColumnEngine`: one sandboxed iframe (`allow-same-origin`
  only — book scripts never run), chapters loaded as `srcdoc` with a
  `<base>` onto `liseur-epub:` (no URL rewriting), pagination via CSS
  multi-columns + a single transform write per page turn.
- `renderer/reader/pagination.ts` — pure, unit-tested page/progression math.
- Locators are Readium-compatible (href + progression/totalProgression +
  position); typography or viewport changes re-layout by progression, so
  positions survive font-size/theme/column changes.
- Positions carry an explicit origin (`PositionOrigin`: `user` / `restore` /
  `relayout`) so the shell can tell real reading activity from incidental
  engine emissions. `user` covers next/previous page, TOC, scrubber, search
  jump, bookmark/highlight jump and in-book links; `restore` is the initial
  `open()` landing on a saved locator; `relayout` is a resize, font-settling
  re-measure, or typography/margin change re-laying out the current chapter.
  Only `user` publishes — persists and syncs — the position; the others
  update the UI's position signal but never touch storage or the network.
- Progress publishing is immediate, not debounced: each accepted user
  navigation synchronously refreshes the localStorage outbox and fires the
  worker's `reader.setProgress` request without the page-turn handler
  awaiting it (visual-first). A monotonically increasing revision guards the
  outbox so an older acknowledgement can never clear a newer pending entry.

### Application-scoped position publisher (worker)

- `worker/reading-position-publisher.ts` — the worker equivalent of the
  Android `ReadingPositionPublisher`: wired once in `worker.ts`, outside any
  reader request handler, so a position accepted here survives the renderer
  that sent it (the same reason Android moved this off the
  Activity/ViewModel). `reader.setProgress` requests are handed to this
  module instead of being persisted inline.
- Ordering: every update is processed strictly one at a time, via a promise
  chain, so writes commit in arrival order even when the renderer fires
  several without awaiting one another (the shape of rapid page turns).
- Sync only starts after commit: `SyncService.enqueueProgress` — durable
  `sync_queue` write + foreground drain signal — runs only once the SQLite
  write and the incremental `bookUpdated` broadcast have completed for that
  exact update. The renderer is acknowledged only after this whole pipeline
  finishes; a failure rejects instead of acknowledging, so the renderer's
  outbox entry survives for replay rather than being silently dropped.

### Reader shell

- Chrome auto-hides after 2.5 s idle ("hidden reading mode") — opacity-only,
  no layout shift, so the book never re-paginates when chrome toggles.
  Pointer movement, key presses, or a center tap bring it back; open
  popovers pin it.
- Typography popover: font size (10–96 px), one/two columns (the page is
  always white — there is no reader theme).
  Preferences persist across sessions via `settings.reader` (merged patches
  in main's settings IPC).
  The reader's font size is set on `<html>` and forced onto the book's text
  with `font-size: inherit !important`. Without this the control does
  nothing on most real books: publishers pin their text with _absolute_
  sizes (`font-size: small`, `11px`), which are resolved from the browser
  default and ignore the page entirely. Headings and small print are
  restated in `em` so the hierarchy scales with the reader's size.
- Line length is capped at a readable measure (`readerMeasurePx`), so a
  maximised window gets margins rather than edge-to-edge lines. Breathing
  room lives on the container _outside_ the iframe: padding inside a multicol
  box applies once around the whole flow, not per page.
- The book's `<body>` box is normalised to the iframe's width (margin,
  padding, border and width forced), and `pageStep()` measures the resulting
  content box rather than assuming it. A page turn advances by exactly
  `content width + gap`; if a book shrinks `<body>` (Calibre emits
  `.calibre { margin: 0 5pt }` on every body it converts) every turn
  overshoots by that inset and the error compounds until words are sliced off
  both edges.
- Scrubber: 0–1000 slider → `targetForProgression` (pure, unit-tested)
  maps to spine item + in-item progression; estimates self-correct on load.
- Shortcuts: ←/→/Space/PgUp/PgDn turn pages, +/- font size, c columns, f/F11 fullscreen, Esc (popovers → fullscreen → library).
- Progress durability: immediate publish on every user navigation, a
  revisioned localStorage outbox (survives crashes; replayed on open), and a
  close handshake — main holds window close until the worker acks the final
  save (bounded at 5 s, released early on worker death). The close-time
  final write is just another publish, ordered after every earlier one by
  the position publisher's promise chain.
- Settings and window state live in the data dir (`LISEUR_DATA_DIR`), so
  e2e runs never touch real user settings.

### Annotations & in-book search

- Schema v3: `annotations` (highlight | bookmark) with JSON locators;
  `AnnotationRepository` in the worker; annotations ride along with
  `reader.open` and CRUD over typed protocol messages.
- Anchoring (`renderer/reader/anchoring.ts`): highlights anchor on CONTENT —
  CSS selector + text quote with context (Readium `text` field) — never on
  geometry, so they survive typography changes and repagination. Matching is
  whitespace/case-insensitive on a normalized copy with an exact index map
  back to raw DOM offsets.
- Rendering: CSS Custom Highlight API (`::highlight`) — zero DOM mutation,
  zero layout cost, reflow-safe by construction.
- Interaction: no overlay buttons (they would block text selection). Clicks
  inside the book resolve as: highlight → popover; link → navigation;
  active selection → ignore; else left/right third turns the page, center
  tap toggles chrome. Pointer/keyboard events inside the iframe are
  forwarded to the shell (they never cross the iframe boundary natively).
- Search: worker scans spine items straight from the EPUB (no extraction),
  normalized text, ≤500 matches, batches stream per item over the port;
  results carry quotes that the engine re-anchors with a flash on jump.

### Remote catalogs & sync

- `worker/sync/` — capability interface `RemoteCatalog` (testConnection,
  streaming listBooks, download, fetchCover, pull/pushProgress,
  markCompleted) with three implementations mirroring the Android app's
  wire contracts: `komga.ts` (X-API-Key, books/list, progression +
  positions), `calibre.ts` (Basic + OPDS catalog parsed with the in-house
  XML scanner; Kobo-protocol progress under `/kobo/<token>/`, token
  provisioned at setup via the web login flow), `liseur-sync.ts` (login →
  scoped bearer token, ops push with deterministic idempotent op ids,
  changes catch-up with 410→heads resync). No catalog/downloads for
  liseur-sync by design.
- Credentials: never in SQLite, never in the renderer after setup. The
  user's secret crosses the in-process port once at setup; the worker
  exchanges it for auth material (Kobo token / scoped bearer) and forwards
  ONLY headers+extras to main, which stores them encrypted with the OS
  keychain (`safeStorage`, `main/secrets.ts`, `secrets.json` mode 0600).
  Main re-pushes decrypted headers to the worker on spawn/connect.
- `sync-service.ts` — orchestration: catalog sync streams pages into remote
  shell rows (server_id + remote_id); downloads land in `$DATA/downloads/`
  with content-hash dedupe (an existing local copy gets linked, not
  duplicated); opening a remote book downloads on demand.
- Progress: every committed local position enqueues into `sync_queue`
  (coalesced per book — an upsert on `book_id` with a monotonically
  increasing version, so several updates landing within the same
  millisecond still stay distinguishable) and signals an immediate
  foreground drain — no timer. Only one network drain runs at a time: a
  signal that arrives while one is already draining just remembers to run
  one more pass afterwards over the latest queued versions, so many pages
  turned during a slow request collapse into a single follow-up rather than
  one push per page. The queue is also flushed on `sync.syncNow` and when
  credentials arrive, and survives restarts for when none of those run
  before the app closes. Delivery is tracked per target in `sync_acks`
  (book × server → acked queue version); a row dequeues only when every
  required target (catalog origin + all liseur-sync servers) has acked that
  exact version. Reconciliation (`reconcile.ts`, pure): epsilon tolerance,
  push/pull/adopt-status, and both-changed-diverged → preserved
  target-scoped `sync_conflicts` row, resolved from the settings UI (Use
  this device / Use server), cleared only after the winning side is durably
  applied. Pull/push results distinguish "missing" from "error" —
  reconciliation never runs on a transport error. A retryable failure keeps
  the persisted row for the next signal (a later page, `sync.syncNow`,
  credentials arriving, or app reconnect/close) — there is no polling or
  idle-timer retry.
- Networking rules: auth headers go only to the configured origin;
  cross-origin redirects of sensitive requests are refused; responses stream
  with byte caps and a whole-exchange timeout.
- Settings UI: `renderer/settings/SettingsScreen.tsx` — server management,
  test connection, sync now, conflict list. The library grid shows a ☁
  badge on server books.

### Reading statistics

- `worker/library/reading-stats.ts` — pure arithmetic over
  `reading_sessions`: per-day buckets (a sitting crossing midnight is split
  across both local days, as the server does), streaks that still count when
  the last day read was yesterday, per-book totals, and the seven-day chart.
  `ReadingStatsRepository` supplies the rows; `mergeServerStats` folds in a
  server's figures.
- Aggregation matches the Android app: a liseur-sync server counts the same
  reading seen from every device, so where it answers it _replaces_ the
  local figure rather than being added to it (adding would count this
  machine twice). `/v1/insights/summary` gives the headline total, sittings
  and streak; `/v1/insights/calendar` the week chart; `/v1/insights/works`
  each book's lifetime total, matched to local books through the same
  work-id links used for position sync. Any part the server does not answer
  keeps its local value; every failure is silent, because a statistics
  screen is not worth an error banner.
- Those routes require the server's separate `read-insights` scope, which a
  `sync` token is refused. Setup mints both tokens and stores the second as
  `extra.insightsToken`; a server that will not grant it still syncs
  positions. A server configured before statistics existed can be granted
  the permission from the settings row (`sync.enableStats`), which asks for
  the password and mints only that credential: removing and re-adding the
  server would unlink every book from it.
- UI: `renderer/stats/StatsScreen.tsx`, opened from the library header.

> Note: Electron 43 utilityProcess children expose `process.parentPort`
> (the `parentPort` export of the `electron` module was removed). The Node
> side builds as CJS for this reason — utilityProcess entries cannot be ESM.

## IPC design

- `src/shared/ipc/protocol.ts` is the single source of truth: typed
  `WorkerRequest` / `WorkerResponse` / `WorkerEvent` unions with request
  ids. No generic string channels, no `invoke(channel, any)`.
- Renderer ↔ worker traffic uses a dedicated `MessagePort` created by main
  via `MessageChannelMain`; main never sees the data.
- Updates are incremental (`bookUpdated` events), never full-list resends.
- Long-running operations get cancellation/stale-result handling via request
  generation counters (renderer) and per-request ids.

## Startup flow

```
start
→ create window (restored bounds, theme background, no white flash)
→ render app shell immediately (first paint not blocked on data)
→ renderer connects to worker port asynchronously
→ library query + continue-reading resolve and stream in
```

Nothing on the critical path touches the network, SQLite, or the filesystem
beyond the tiny window-state read.

## Threat model

- EPUB files and remote servers are untrusted input.
- The renderer is sandboxed with a strict CSP (`default-src 'self'` plus the
  two app schemes); the only bridge is the typed preload API.
- EPUB content renders in a sandboxed iframe (no `allow-scripts`) injected
  as `srcdoc` with a lockdown CSP meta (`default-src 'none'` + book-scheme
  allowances for styles/images/fonts); the `liseur-epub:` scheme adds
  `script-src 'none'` and path-traversal guards; ZIP parsing enforces
  entry/size/count limits.
- Credentials use OS keychain encryption (`safeStorage` in
  `main/secrets.ts`) — never plaintext at rest, never in SQLite, never in
  the renderer after setup. Chromium only auto-detects a keyring on GNOME and
  KDE, so on Linux main forces `--password-store=gnome-libsecret` (see
  `main/main.ts`) — otherwise every other desktop silently degrades to an
  unencrypted store and `safeStorage` reports itself unavailable. Setup fails
  loudly rather than storing plaintext; the secrets file is written mode 0600.
