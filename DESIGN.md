# Liseur Desktop — Design & Roadmap

Liseur Desktop is the desktop counterpart of the Android EPUB reader
[Liseur](https://github.com/chmouel/liseur). It is a reading application that
happens to use web technology, not a website packaged into a desktop window.

The overriding quality goal is **snappiness**: the app must feel as immediate
as a well-optimized desktop editor such as VS Code. Perceived latency beats
feature completeness. See `PERFORMANCE.md` for the concrete budgets and
`AGENTS.md` for the non-negotiable engineering rules.

> **Living document.** Keep this file current: when a milestone starts,
> finishes, or changes scope, update the status below in the same change.

## Product reference

The Android app (`~/git/perso/liseur`) defines the product model: local-first
EPUB library, calibre-web / Komga / liseur-sync integration, exact Readium
locators, bookmarks/highlights/notes, reading statistics, typography
configuration, sync conflict handling.

Branding — "paper & ink" palette:

| Token       | Value                             |
| ----------- | --------------------------------- |
| Paper       | `#FFFFFF`                         |
| Ink         | `#15110C`                         |
| Leather     | `#7A4A2B` / `#5C3018` / `#FFDCC3` |
| LeatherSoft | `#8B5E3C`                         |
| Teal        | `#3A5F5C` / `#BDECE6`             |
| Logo field  | `#FCF4ED`                         |
| Dark bg     | `#17130E`                         |

The reader has no theme of its own: a page is paper `#FFFFFF` with ink
`#1A1A1A`, and the reader chrome paints the same white so page and shell read
as one surface. Colour schemes belong to the app chrome, not to the text.

Fonts (later milestones): Publisher default, Literata, Vollkorn,
Atkinson Hyperlegible, Inter.

Library UX conventions carried over from Android:

- Filters: **All / Downloaded / Unread / Archived** (Archived is special)
- Sorts: **Recent / Title / Author / Recently added**; activating the current
  sort flips its direction
- Search preserves its query when closed and reopened
- Continue Reading card: cover + label + title + author + progress bar + percent
- Book card: cover + badges (download/server/finished) + title + author

## Architecture summary

Three strictly separated layers (details in `ARCHITECTURE.md`):

1. **Main process** — deliberately small: lifecycle, windows, menu, IPC wiring,
   utility-process creation. No parsing, DB, scanning, or networking.
2. **Renderer** (SolidJS) — presentation and immediate interaction only.
   `contextIsolation: true`, `nodeIntegration: false`. Never touches Node,
   filesystem, SQLite, or the network.
3. **Worker** (Electron `utilityProcess`) — owns all expensive work:
   SQLite library queries now; EPUB parsing, scanning, and server sync
   later.

The renderer talks to the worker asynchronously through a narrow, typed
preload API (`window.liseur.*`). Updates are incremental (per-book events),
never full-dataset resends.

## Roadmap

| Milestone                             | Scope                                                                                                                                                                                                                                                            | Status  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **M0 — Foundation**                   | Electron + Vite + SolidJS + strict TS scaffold, secure process boundaries, worker skeleton, typed preload API, instant app shell, docs, CI                                                                                                                       | ✅ done |
| **M1 — Responsive library prototype** | Library screen with 5,000 deterministic fake books, virtualized adaptive cover grid, Continue Reading, filters, sorting, instant search, keyboard navigation, light/dark themes, perf instrumentation, tests                                                     | ✅ done |
| **M2 — SQLite library**               | Database + tested migrations, books/folders/progress tables, background DB in worker, typed renderer API replaces fake data; 10,000-book library stays responsive                                                                                                | ✅ done |
| **M3 — EPUB ingestion**               | Open EPUB, add/rescan folders, metadata + cover extraction, thumbnail cache, duplicate identification, progressive background scanning                                                                                                                           | ✅ done |
| **M4 — Reader proof of concept**      | Minimal reader: pagination, one/two columns, locator restore, font size, TOC. Evaluate Readium Web; choose the engine behind a `ReaderEngine` abstraction ([ADR 0001](docs/adr/0001-reader-engine.md))                                                           | ✅ done |
| **M5 — Polished reader shell**        | Reader chrome, hidden reading mode, shortcuts, typography popover, progress footer, scrubber, full-screen, return to library                                                                                                                                     | ✅ done |
| **M6 — Annotations & in-book search** | Selection, highlights, notes, bookmarks, full-book streaming search, jump-to-result; locators stable across typography changes                                                                                                                                   | ✅ done |
| **M7 — Remote catalogs & sync**       | One server at a time, in order: **Komga → calibre-web → liseur-sync**. Connection settings, test connection, catalog sync, downloads, progress sync, conflict/catch-up UI. Capability-based interfaces; debounced/coalesced sync queue persisted across restarts | ✅ done |

Later (unscheduled): reading statistics UI, Markdown export of annotations,
configurable shortcuts, packaging polish (signing, auto-update, installers,
release automation).

### Milestone rules

- Do **not** start a milestone early to make a demo look complete.
- Remote/sync work is deliberately last: M0–M1 prove the async architecture
  (worker process, typed API, incremental events) that sync later slots into.
- Each milestone's acceptance criteria live in the original spec and must pass
  before moving on. Performance regressions are bugs.
- Packaging stays minimal (unsigned unpacked build) until after the first
  functional reader prototype.
