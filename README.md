# Liseur Desktop

A snappy cross-platform desktop EPUB reader — the desktop counterpart of
[Liseur for Android](https://github.com/chmouel/liseur).

Liseur Desktop is a reading application that happens to use web technology,
not a website packaged into a desktop window. The design goal above all
others is **snappiness**: UI interactions react instantly, typing never waits
for the database, scrolling stays at 60/120 Hz, and expensive work never runs
on the renderer's critical path.

## Status

Milestones 0–4 complete: the foundation (secure Electron architecture), the
responsive library prototype (virtualized cover grid with instant search,
filters, sorting, keyboard navigation, light/dark themes), the
SQLite-backed library (tested migrations, 10,000 books staying snappy),
EPUB ingestion (open files, watch folders, metadata + covers, duplicate
detection, progressive background scanning), and the reader proof of
concept (pagination, one/two columns, locator restore, font size, reader
themes, TOC — engine chosen in [ADR 0001](docs/adr/0001-reader-engine.md)),
and the polished reader shell (auto-hiding chrome, typography popover with
persisted preferences, scrubber, full-screen, shortcuts), annotations and
in-book search (highlights with notes, bookmarks, streaming search with
jump-to-result, typography-stable locators), and remote catalogs with sync
(Komga, calibre-web and liseur-sync: catalog sync, downloads, progress sync
with conflict resolution, keychain-stored credentials). All milestones in
[DESIGN.md](DESIGN.md) are complete.

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

The e2e suite opens real application windows, which steal focus while they
run. To keep them off your screen, run them inside a headless compositor:

```bash
printf 'output HEADLESS-1 mode 1600x1000\n' > /tmp/sway-headless.conf
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -c /tmp/sway-headless.conf &
# sway prints its socket name; use it below (wayland-2 here)
env -u DISPLAY WAYLAND_DISPLAY=wayland-2 pnpm test:e2e
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
