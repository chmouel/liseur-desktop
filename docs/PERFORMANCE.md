# Performance

"Lightweight" for Liseur Desktop means lightweight in behavior, architecture,
CPU usage, dependency count, and UI complexity — not minimal RAM or binary
size. Optimize for **perceived latency** before feature completeness.

## Budgets (engineering targets)

- Immediate feedback to pointer and keyboard input; <16 ms local UI reaction.
- No renderer long tasks above ~50 ms during normal use.
- Search input updates on the same frame as the keypress.
- Menus and filters give immediate visual feedback.
- Zero continuous polling; near-zero idle CPU.
- No loading spinners where cached/existing content can be shown instead.

## How to measure

Enable dev instrumentation with `localStorage.liseurPerf = '1'` in DevTools
(or `VITE_LISEUR_PERF=1` at build time): startup marks, library query
latency, and long-task warnings appear in the console.

The e2e suite (`pnpm test:e2e`) includes a perf smoke test: with 5,000 books
it asserts the DOM stays virtualized (bounded card count) and measures the
search round-trip.

## Measured — library prototype (dev machine, 5,000 fake books)

- App shell render: immediate (window shows on `ready-to-show`).
- Library query round-trip through the worker: single-digit ms.
- Search round-trip incl. 80 ms debounce: ~200 ms end-to-end in e2e.
- DOM nodes while scrolling 5,000 books: bounded (~275 cards worst case on
  a large window), independent of library size.

## Measured — SQLite library (dev machine, 10,000 seeded books)

- Migration to schema v1: <1 ms; dev seed of 10,000 books: ~50 ms, both in
  the worker while the window is already painting.
- Full-library query (9,200 rows incl. row→Book mapping): ~40 ms cold,
  faster warm; filtered/sorted queries 2–16 ms; search ~3 ms.
- Search round-trip incl. 80 ms debounce: ~160 ms end-to-end in e2e.
- DOM nodes while scrolling: unchanged, bounded (~275 cards worst case).

## Measured — EPUB ingestion (dev machine)

- Ingesting one EPUB (read + sha256 + ZIP/OPF parse + cover cache write):
  single-digit ms; scans yield between books so library queries interleave.
- Startup folder rescan with no changes: stat-only fast path (mtime+size),
  no file reads or hashing.
- Cover images are served as files over the `liseur-cover:` scheme and
  decoded lazily (`loading="lazy"` + `decoding="async"`) by the virtualized
  grid only — never base64 over IPC, never all-at-once.
- Cover cache is content-addressed and write-once: re-ingests and books
  sharing a cover cost zero extra disk writes.

## Measured — reader (dev machine)

- Page turn: one `transform` style write — no reflow, no IPC, no DB. A
  position update is fired asynchronously right after (outbox mirror +
  worker request), but the page-turn handler never awaits it: the visual
  update and the persistence/sync pipeline are on separate turns of the
  event loop.
- Chapter load: one `liseur-epub:` fetch + parse + first layout; adjacent
  cost is paid once per chapter, not per page.
- Book open: cold extraction (unzip to `$DATA/extracted/`) tens of ms for a
  typical EPUB, off the renderer; warm opens skip it (mtime+size marker).
- Typography/theme/column changes re-layout the current chapter only and
  restore position by progression — no re-render of the book, and no
  publish: a relayout is not reading activity (see `PositionOrigin` in
  `engine.ts`).
- e2e: open → paginate → TOC jump → close → reopen restores the exact
  locator (assertion on the rendered chapter and footer).

## Measured — annotations, search & sync (dev machine)

- Highlights render via the CSS Custom Highlight API: zero DOM mutation, no
  relayout on render or on typography change (ranges are content-anchored).
- In-book search streams per chapter off the EPUB zip; superseded scans stop
  immediately (explicit cancel), so fast typers never queue stale work.
- Sync: catalog pages stream in (bookAdded per page, never a full resend);
  each committed position enqueues into a persisted, per-book coalesced
  queue and signals an immediate foreground drain — no timer. Only one
  network drain runs at a time; further signals during it collapse into one
  follow-up pass, so rapid page turns cost at most one extra round trip, not
  one per turn. Page turns still never wait on the network: the signal
  starts the drain asynchronously, off the page-turn handler.
- e2e against a real local HTTP server: a real page turn reaches the mock
  server in well under the old 2 s debounce window; full add-server → sync
  → download → read → progress-push cycle in ~2 s.

## Rules that protect the budgets

See AGENTS.md for the full non-negotiable list. In short: never block the
renderer; visual-first, persistence-second; local-first search input;
virtualize; lazy-load covers; incremental updates over full resends.

## Dependency policy

Every dependency must justify itself: is there a browser/Node API? Is it
maintained? How big is it? Does it run at startup? Does it execute in the
renderer? Current runtime dependencies: **none** (SolidJS, Electron and
tooling are devDependencies; the app ships only what the build emits).

Performance-sensitive notes:

- `Literata` — two bundled variable TTFs (about 1.9 MB source total) provide
  consistent offline reading typography. They are requested by the sandboxed
  chapter only when a book opens; `font-display: swap` keeps first paint and
  page turns non-blocking.
- `solid-js` — chosen for fine-grained reactivity (no VDOM diffing), which
  keeps list updates cheap.
- `node:sqlite` — Node's built-in SQLite, used from the worker only.
  Avoids a native npm dependency (better-sqlite3) that would need rebuilding
  against Electron headers. Synchronous access is safe there: the worker is
  a separate process, so queries never block the renderer.
- Virtualization is a small in-house module (`src/renderer/library/virtualize.ts`)
  instead of a dependency.
- Placeholder covers are inline SVG data URIs — no decoding storm, no assets.

## Anti-patterns (do not do these)

Synchronous IPC; synchronous filesystem on renderer or on main during
startup; huge repeated IPC payloads; re-sending the whole library after a
one-book change; decoding large images every render; mounting thousands of
DOM nodes; expensive derived state recomputed per frame; broad signals that
rerender the whole app; polling servers; unbounded listeners; a
BrowserView per book card; network requests in page-turn handlers.
