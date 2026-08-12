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
│   all expensive work: library data now; SQLite, EPUB     │
│   parsing, scanning, search indexing, server sync later  │
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
connected renderer port. Milestone 1 serves a deterministic 5,000-book fake
dataset (`library/fake-dataset.ts`, seeded PRNG); Milestone 2 swaps the
implementation behind the same typed protocol for SQLite.

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

## Threat model (stub, to be expanded with the reader)

- EPUB files and remote servers are untrusted input.
- The renderer is sandboxed with a strict CSP (`default-src 'self'`); the
  only bridge is the typed preload API.
- Future EPUB content will render in a separately sandboxed iframe with its
  own CSP; publication JavaScript gets no privileges.
- Credentials (M7) must use OS keychain storage behind an interface — never
  plaintext, never in SQLite.
