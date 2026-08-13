# TODO

No open `TODO`/`FIXME`/`XXX`/`HACK` comments exist anywhere in the source
tree. Everything below comes from comparing `docs/DESIGN.md` and the
retired milestone roadmap against what actually exists in `src/`.

## Reader

- **Font-family selection.** The reader now bundles and defaults to Literata,
  but the typography popover (`ReaderScreen.tsx`) still only has font size,
  columns and margins. Needs a `fontFamily` preference, the remaining planned
  fonts, and a UI row to choose them or return to Publisher default.

## Library / sync

- **Markdown export of annotations.** No export code exists anywhere in
  `src/`.
- **Configurable shortcuts.** Reader keys (arrows/space/PgUp/PgDn/+/-/c/f/
  F11/Esc) are hardcoded in `ReaderScreen.tsx`, and the vim bindings in
  `src/renderer/vim/keymap.ts` are fixed tables; there is no remapping UI
  or settings entry beyond the on/off switch for vim mode.

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
