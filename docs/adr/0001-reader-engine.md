# ADR 0001 — Reader engine: in-house column engine behind `ReaderEngine`

Status: accepted (Milestone 4)

## Context

The reader needs an engine that renders EPUB spine items, paginates them,
and reports Readium-compatible locators. The milestone brief calls for
evaluating Readium Web and choosing behind a `ReaderEngine` abstraction.

### Option A: Readium Web (`@readium/ts-toolkit`)

`@readium/shared` + `@readium/navigator` + `@readium/navigator-html-injectables`
are the real, maintained, production-used toolkit (Thorium Web, De Marque).
Strengths: battle-tested pagination/FXL logic, decorator API for
highlights, accessibility work, a community.

Friction for this codebase:

- **Dependency weight and policy.** Three packages plus their transitive
  tree run in the renderer — the most performance-critical process.
  AGENTS.md forbids casual dependencies; PERFORMANCE.md budgets renderer
  work in single-digit ms.
- **Architecture mismatch.** The toolkit expects publications served over
  HTTP(S) via its Fetcher abstraction (a publication server or a custom
  fetcher bridging to our worker). Our architecture already serves extracted
  book content over the `liseur-epub:` scheme straight from disk; a Readium
  fetcher would re-add a translation layer over it.
- **Process boundaries.** Publication parsing in ts-toolkit is designed for
  the browser; our rules put all EPUB parsing in the worker (`src/worker/`).
- **Control over latency.** Snappiness is the defining quality goal; the
  pagination hot path (page turns, relayout) benefits from being small,
  fully understood, and measured by us.

### Option B: in-house engine (chosen)

`ColumnEngine` (`src/renderer/reader/engine.ts`): one sandboxed iframe,
chapters injected as `srcdoc` with a `<base>` onto the `liseur-epub:` scheme,
pagination via CSS multi-columns + transform. ~250 lines of engine plus a
pure, fully unit-tested math module (`pagination.ts`).

- Zero new dependencies.
- Page turns are a single style write — no reflow, no network, no DB.
- Fits the worker/scheme architecture exactly; no fetcher adaptation.
- Locators remain **Readium Web-compatible** (`href` + `locations.
progression/totalProgression/position` + optional text context), so sync
  with the Android app (Readium-based) stays possible in M7.

Risks accepted: we own the pagination bugs; fixed-layout, RTL and vertical
writing are out of scope for now (reflowable LTR EPUBs only); CSS-heavy
books may need engine hardening later.

## Decision

Implement the in-house `ColumnEngine` behind the `ReaderEngine` interface
(`src/renderer/reader/engine.ts`). The interface — open/next/prev/goToHref,
preferences, locator, pageInfo — is the only surface the UI uses, so a
future switch to Readium Web is a localized rewrite of one module.

Revisit when: fixed-layout/RTL support becomes a requirement, or the
decorator/highlight machinery of M6 outgrows the in-house approach.

## Consequences

- The `ReaderEngine` interface is stable API; engines are interchangeable.
- All reader UI state flows through `ReaderPreferences` + `PageInfo`.
- Book content never runs scripts (sandboxed iframe, no `allow-scripts`;
  `script-src 'none'` CSP on the scheme as defense in depth).
