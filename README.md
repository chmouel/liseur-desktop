# Liseur Desktop

A snappy cross-platform desktop EPUB reader — the desktop counterpart of
[Liseur for Android](https://github.com/chmouel/liseur).

Liseur Desktop is a reading application that happens to use web technology,
not a website packaged into a desktop window. The design goal above all
others is **snappiness**: UI interactions react instantly, typing never waits
for the database, scrolling stays at 60/120 Hz, and expensive work never runs
on the renderer's critical path.

## Status

Milestones 0 + 1 complete: the foundation (secure Electron architecture) and
the responsive library prototype (5,000-book virtualized library with instant
search, filters, sorting, keyboard navigation, light/dark themes). See
[DESIGN.md](DESIGN.md) for the roadmap — SQLite arrives in M2, the EPUB
reader in M4–M5, remote catalogs/sync in M7.

## Development setup

Requires Node.js ≥ 20 and pnpm (`npm install -g pnpm`).

```bash
pnpm install
pnpm dev        # dev mode with hot reload
pnpm build      # production build into out/
pnpm start      # preview the production build
pnpm package    # unsigned unpacked app into release/ (no installers yet)
```

## How to run checks

```bash
pnpm typecheck  # strict TypeScript (Node side + web side)
pnpm lint       # ESLint
pnpm test       # Vitest unit tests
pnpm test:e2e   # Playwright tests against the production build
```

## Architecture

Three strictly separated process layers:

1. **Main** (`src/main/`) — deliberately small: windows, menu, IPC wiring,
   worker spawning. No parsing, DB, scanning, or networking.
2. **Renderer** (`src/renderer/`) — SolidJS presentation only.
   `contextIsolation: true`, `nodeIntegration: false`, sandboxed. Never
   touches Node, filesystem, or the network; all data flows through the
   typed `window.liseur` preload API.
3. **Worker** (`src/worker/`) — an Electron `utilityProcess` owning all
   expensive work (library data now; SQLite, EPUB, scanning, sync later).

Details: [ARCHITECTURE.md](ARCHITECTURE.md). Performance rules and budgets:
[PERFORMANCE.md](PERFORMANCE.md). Engineering constraints for contributors:
[AGENTS.md](AGENTS.md).

## Project structure

```
src/
├── main/        # Electron main: window, menu, IPC, worker host
├── preload/     # Typed contextBridge API (window.liseur)
├── worker/      # utilityProcess: library data & query engine
├── renderer/    # SolidJS UI: app shell, library, styles
└── shared/      # Domain types + IPC protocol shared by all layers
tests/
├── unit/        # Vitest (dataset determinism, query engine, virtualization)
└── e2e/         # Playwright (launch, security, search, filters, perf)
```

## License

MIT — see [LICENSE](LICENSE).
