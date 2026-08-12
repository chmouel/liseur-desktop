# AGENTS.md — Engineering constraints for coding agents

You are working on **Liseur Desktop**, a desktop EPUB reader whose defining
quality is **snappiness**. Read this file and
[docs/DESIGN.md](docs/DESIGN.md) before changing anything, and keep
docs/DESIGN.md updated as the design changes. Check
[docs/TODO.md](docs/TODO.md) for known-missing work before starting a
feature: remove an item once it's implemented, and add one if you spot
outstanding or planned work that isn't tracked there yet.

## Non-negotiable rules

1. Never block the renderer. No filesystem, SQLite, EPUB parsing, network,
   catalog, cover, or indexing operation may run synchronously on the
   renderer or on the main process during startup.
2. Never block startup on networking. The window renders first; servers are
   contacted only afterwards, asynchronously.
3. Never wait for persistence before showing user feedback.
4. Page turns are visual-first, persistence-second. No network or database
   work in a page-turn handler.
5. Search text is local-first: the input re-renders on the same frame as the
   keypress; only the results query is asynchronous (and may be debounced).
6. Virtualize large lists. Never mount thousands of DOM nodes.
7. Lazy-load covers; never decode every cover at startup.
8. Keep the main process small: lifecycle, windows, menus, IPC wiring only.
9. Put expensive work in the worker utilityProcess (`src/worker/`).
10. Measure before introducing complex optimization. Use the dev perf
    instrumentation (`localStorage.liseurPerf = '1'`).
11. Do not add dependencies casually. Check: does a browser/Node API already
    solve it? Is it maintained? How big is it? Does it run at startup?
    Document performance-sensitive additions in docs/PERFORMANCE.md. A dependency
    is also a supply-chain liability: it must be installable under the
    fourteen-day cooldown in `pnpm-workspace.yaml`, must not need an install
    script (adding a name to `allowBuilds` requires a written justification in
    the pull request), and must come from the registry rather than a git URL
    or a tarball. See SECURITY.md.
12. Prefer incremental updates (per-book events) over replacing entire
    datasets or re-sending the whole library over IPC.
13. An idle application must perform no recurring work — no polling timers
    unless strictly necessary.
14. Performance regressions are bugs. Fix them before adding features.
15. Never put a co-author on a commit without their explicit approval. If you are unsure, ask.

## Process boundaries (enforced, not advisory)

- `src/renderer/` must never import `electron` or Node builtins
  (ESLint `no-restricted-imports` enforces this).
- The renderer reaches data only through the typed preload API
  (`window.liseur.*`). Never add a generic `invoke(channel, args)` bridge.
- `src/main/` must never parse EPUBs, query SQLite, scan directories, fetch
  catalogs, or extract covers.
- All new renderer↔worker operations go through the typed message protocol
  in `src/shared/ipc/protocol.ts` — no magic channel strings.

## Tech constraints

- TypeScript strict mode; keep it green (`pnpm typecheck`).
- SolidJS signals/stores only. No Redux, no global state framework.
- Plain CSS with the variables in `src/renderer/styles/tokens.css`. No CSS
  frameworks, no hard-coded hex colors in components.
- The reader has no theme: the page and the reader chrome are always white.
  The app theme (light/dark) stops at the reader's door.
- Avoid animations unless they serve perceived latency; never animate
  typography reflow.

## Verification

Before considering work done: `pnpm typecheck`, `pnpm lint`, `pnpm test`,
and `pnpm test:e2e` must pass. Add unit tests for worker logic and
virtualization math; add Playwright tests for user-facing behavior changes.

`pnpm test:e2e` launches the built app from `out/`, and does **not** build
first. A stale `out/` makes every spec for new work time out at 30 s with no
useful error, so run `pnpm build` before it.

### Never open test windows on somebody's screen

The end-to-end tests open real application windows. On a developer machine
they steal focus and the keyboard for the length of the run, and a stray
click lands in whatever they are doing. Someone may be working at that
screen right now, so on Linux always run them through the wrapper:

```bash
pnpm build && pnpm test:e2e:headless
```

It starts a nested headless compositor, runs the command inside it, and
kills it afterwards. Use it for any throwaway script that opens a window
too (`scripts/headless.sh node my-probe.mjs`), not just the suite. Where
there is no Wayland session — CI, macOS — it runs the command unchanged.

Two things it gets right that are easy to get wrong by hand:

- **Never hard-code a `wayland-N` name.** Which one a nested compositor
  gets depends on what is free, dead sockets litter the runtime directory,
  and `wayland-1` is usually the _real_ session. Guessing wrong puts the
  tests on the user's actual desktop. The wrapper asks the compositor
  instead: sway sets `WAYLAND_DISPLAY` for anything it starts.
- **Unset `SWAYSOCK`, not just `DISPLAY`.** `swaymsg` follows `SWAYSOCK`,
  which keeps naming the real session however `WAYLAND_DISPLAY` is set, so
  a command meant for the test compositor otherwise rearranges the user's
  windows.

Electron's own `--ozone-platform=headless` is not an option; it crashes on
startup. Xvfb works if sway is unavailable.

## Git

- Commitizen messages without scopes: `type: summary` (concise subject,
  body wrapped ~72 cols, layperson terms).
- Never amend/rebase/force-push without explicit approval.
