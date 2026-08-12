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

## Measured (Milestone 1, dev machine, 5,000 fake books)

- App shell render: immediate (window shows on `ready-to-show`).
- Library query round-trip through the worker: single-digit ms.
- Search round-trip incl. 80 ms debounce: ~200 ms end-to-end in e2e.
- DOM nodes while scrolling 5,000 books: bounded (~275 cards worst case on
  a large window), independent of library size.

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

- `solid-js` — chosen for fine-grained reactivity (no VDOM diffing), which
  keeps list updates cheap.
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
