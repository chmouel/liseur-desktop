# TODO

No open `TODO`/`FIXME`/`XXX`/`HACK` comments exist anywhere in the source
tree. Everything below comes from comparing `docs/DESIGN.md` and the
retired milestone roadmap against what actually exists in `src/`.

## Reader

- **Font-family selection.** `docs/DESIGN.md:35` names Literata, Vollkorn,
  Atkinson Hyperlegible and Inter as planned reader fonts. Nothing selects,
  loads or applies a font family anywhere in `src/renderer/reader`; the
  typography popover (`ReaderScreen.tsx`) only has font size, columns and
  margins, and `reader-theme.ts` only ever sets `font-size`. Needs a
  `fontFamily` preference, bundled webfonts (none are vendored today), a UI
  row in the popover, and `font-family` wiring into the injected book CSS.

## Library / sync

- **Reading statistics UI.** Sessions are already recorded and pushed to
  liseur-sync (`src/worker/library/reading-sessions.ts`,
  `src/worker/sync/sync-service.ts`), but no screen in `src/renderer`
  displays them.
- **Markdown export of annotations.** No export code exists anywhere in
  `src/`.
- **Configurable shortcuts.** Reader keys (arrows/space/PgUp/PgDn/+/-/c/f/
  F11/Esc) are hardcoded in `ReaderScreen.tsx`; there is no remapping UI or
  settings entry.

## Packaging

- **Real Windows installer.** `electron-builder.json` builds `win.target:
  dir` only — no NSIS or other installer.
- **Auto-update.** No `electron-updater` or equivalent is wired up.
- **Code signing.** Builds are unsigned (`mac.identity: null`). Note: this
  one is a deliberate, argued-for tradeoff in `SECURITY.md` ("no
  certificate, and buying one for a hobby project is hard to justify"),
  while `DESIGN.md`'s backlog still lists signing as future packaging
  polish. Worth resolving that contradiction — either drop signing from the
  backlog or update SECURITY.md's reasoning — rather than treating it as a
  plain TODO.

## Documentation gap

- The reader-engine ADR (in-house `ColumnEngine` chosen over Readium Web)
  was deleted along with the milestone roadmap. Its revisit condition —
  fixed-layout/RTL support becomes a requirement, or the highlight
  machinery outgrows the in-house approach — isn't tracked anywhere now.
  Neither condition currently applies (no RTL/fixed-layout code exists,
  and the CSS Custom Highlight API-based annotations show no sign of
  outgrowing the engine), but if RTL or fixed-layout work is ever
  requested, there's no written record of why Readium Web was passed over
  or what would justify revisiting that choice.
