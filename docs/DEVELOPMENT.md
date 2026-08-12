# Development

Requires Node.js 20 or newer and pnpm (`npm install -g pnpm`).

```bash
pnpm install
pnpm dev        # hot reload
pnpm build      # production build into out/
pnpm start      # run the production build
pnpm package    # unpacked, unsigned app into release/
```

## Checks

```bash
pnpm typecheck  # strict TypeScript, Node side and web side
pnpm lint       # ESLint
pnpm test       # Vitest
pnpm test:e2e   # Playwright, against the production build
```

`pnpm test:e2e` runs the built app, so `pnpm build` has to come first.

## Keeping the tests off your screen

The end-to-end tests open real application windows. They pop up and take the
keyboard, which makes the machine unusable while they run. Give them a
hidden desktop of their own instead:

```bash
printf 'output HEADLESS-1 mode 1600x1000\n' > /tmp/sway-headless.conf
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -c /tmp/sway-headless.conf &
# sway prints its socket name on startup; wayland-2 here
env -u DISPLAY WAYLAND_DISPLAY=wayland-2 pnpm test:e2e
```

Xvfb works too if you have it. Electron's own `--ozone-platform=headless`
does not; it crashes on startup.

## A library big enough to measure

The app only ever shows books you added, so a fresh install has nothing to
profile. For work on the grid, search or virtualization, ask for a
deterministic 10,000-book dataset. It is generated from a fixed seed, so
timings can be compared between runs, and it is only ever added to a library
that is still empty:

```bash
LISEUR_SEED_FAKE_LIBRARY=1 pnpm dev
```

To watch where the time goes, set `localStorage.liseurPerf = '1'` in DevTools.
See [PERFORMANCE.md](../PERFORMANCE.md).

## Working with a throwaway library

`LISEUR_DATA_DIR` moves the database, covers, settings and credentials
somewhere else, leaving your real library alone:

```bash
LISEUR_DATA_DIR=/tmp/liseur-scratch pnpm start
```

The end-to-end tests use this for a fresh library per run.

## Layout

```
src/
├── main/        # Electron main: window, menu, IPC, worker host
├── preload/     # Typed contextBridge API (window.liseur)
├── worker/      # utilityProcess: database, EPUB parsing, scanning, sync
├── renderer/    # SolidJS UI: library, reader, settings, styles
└── shared/      # Domain types and the IPC protocol
tests/
├── unit/        # Vitest: worker logic, pagination and layout arithmetic
└── e2e/         # Playwright: launch, security, library, reader, sync
```

Which process may do what is not a matter of taste; see
[ARCHITECTURE.md](../ARCHITECTURE.md) for the boundaries and
[AGENTS.md](../AGENTS.md) for the rules that come with them.
