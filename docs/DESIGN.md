# Liseur Desktop — Design

Liseur Desktop is the desktop counterpart of the Android EPUB reader
[Liseur](https://github.com/chmouel/liseur). It is a reading application that
happens to use web technology, not a website packaged into a desktop window.

The overriding quality goal is **snappiness**: the app must feel as immediate
as a well-optimized desktop editor such as VS Code. Perceived latency beats
feature completeness. See `PERFORMANCE.md` for the concrete budgets and
`AGENTS.md` for the non-negotiable engineering rules.

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

Planned fonts: Publisher default, Literata, Vollkorn, Atkinson Hyperlegible,
Inter.

Library UX conventions carried over from Android:

- Filters: **All / Downloaded / Unread / Archived** (Archived is special)
- Sorts: **Recent / Title / Author / Recently added**; activating the current
  sort flips its direction
- Search preserves its query when closed and reopened
- Continue Reading card: cover + label + title + author + progress bar + percent
- Book card: cover + badges (download/server/finished) + title + author

## Vim mode

An optional keyboard grammar for people who already have one in their
fingers, off until Settings turns it on. It is strictly additive: arrows,
space, PageUp/PageDown, Escape, F11 and the menu accelerators behave the
same whether it is on or off, because a vim key is only claimed when it is
bound and nothing else answers to it.

- `src/renderer/vim/keymap.ts` is pure and testable: it encodes a key event
  as a token, runs the count + multi-key state machine (`2j`, `10G`, `]]`),
  and holds the two binding tables. Everything else — the screens, the `?`
  sheet, the tests — reads those tables, so the keys cannot drift from
  their own documentation.
- `src/renderer/vim/vim.ts` is the reactive glue: the setting signal and a
  per-screen session that tracks the pending sequence, forgets it after
  1.2 s, and never intercepts a keystroke aimed at a text field.
- Escape belongs to the app, not to vim: it drops a half-typed sequence if
  there is one, otherwise it closes what is open and finally leaves the
  book. `q` steps out the same way.

## Architecture summary

Three strictly separated layers (details in `ARCHITECTURE.md`):

1. **Main process** — deliberately small: lifecycle, windows, menu, IPC wiring,
   utility-process creation. No parsing, DB, scanning, or networking.
2. **Renderer** (SolidJS) — presentation and immediate interaction only.
   `contextIsolation: true`, `nodeIntegration: false`. Never touches Node,
   filesystem, SQLite, or the network.
3. **Worker** (Electron `utilityProcess`) — owns all expensive work:
   SQLite library queries, EPUB parsing, scanning, and server sync.

The renderer talks to the worker asynchronously through a narrow, typed
preload API (`window.liseur.*`). Updates are incremental (per-book events),
never full-dataset resends.

## Not yet built

Markdown export of annotations, configurable shortcuts, packaging polish
(signing, auto-update).
