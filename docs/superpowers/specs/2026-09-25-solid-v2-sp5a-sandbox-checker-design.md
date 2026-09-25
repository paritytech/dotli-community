# Solid v2 migration — sub-project 5a: sandbox-checker panel

Status: written while the owner was AFK (2026-09-25), under the standing
instruction to continue without approval stops and record decisions in
`SOLID_MIGRATION_QUESTIONS.md`. Parent: `2026-09-25-solid-v2-ui-migration-design.md`
(sub-project 5, dev tools). Sub-project 5 is split: **5a** (this spec) is the
sandbox-checker violation panel; **5b** is the truapi-debug panel, which needs
characterization tests before any port (it has none, ~7,700 lines, and
deliberately imperative render paths) and gets its own spec.

## Goal

Render the dev-only sandbox-checker violation panel as a Solid component,
with identical markup, behaviour and copy, and remove the hand-built DOM.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Location | The component lives in `@dotli/ui` (`packages/ui/src/components/sandbox-checker/`) because `mountRoot` and `useStore` live there and `@dotli/sandbox-checker` must not depend on `@dotli/ui` (that would be a cycle). `@dotli/sandbox-checker` keeps only the injected checker script (`sandbox-checker.ts`); `sandbox-checker-ui.ts` is deleted |
| 2 | Loading | Unchanged: `bridge.ts` already imports the panel dynamically and only when `VITE_SANDBOX_CHECKER` is set; it now imports `@dotli/ui/components/sandbox-checker/mount` instead |
| 3 | Security | Violation fields are product-controlled; they reach the DOM only as JSX text (today they go through a local `escapeHtml` into `innerHTML`) |
| 4 | Iframe geometry | Unchanged: the panel still writes the product iframe's height (until `product-frame-layout.ts` in sub-project 4) |
| 5 | Markup | The panel root keeps `id="sandbox-checker-panel"` and its `visible` / `collapsed` classes; it is rendered inside a plain wrapper `div` appended to `body` (the Solid container). CSS in `packages/ui/src/styles/sandbox-checker.css` is unchanged |

## Behaviour (unchanged)

- `mountViolationPanel(iframe: HTMLIFrameElement): () => void` replaces
  `setupViolationPanel(iframe)` with the same contract: listen for
  `DOTLI_API_VIOLATION` messages whose `event.source` is the iframe's window;
  return a dispose function.
- Hidden until the first violation, then `.visible`; `.sc-badge` counts
  violations; each entry is `.sc-entry` with `.sc-time`
  (`toLocaleTimeString`), `.sc-api`, and `.sc-details` (`key=value` pairs
  joined by spaces, omitted when there are none); the log scrolls to the
  newest entry.
- `.sc-toggle` ("▼" expanded / "▲" collapsed, `aria-label="Toggle panel"`)
  toggles `.collapsed` and clears any custom height when collapsing.
- `.sc-resize-handle` drags the height between 40 px and 80% of the viewport
  (not while collapsed), setting the panel height and the log `max-height`
  (height minus 37 px), with `user-select: none` on `body` while dragging.
- The iframe height is `calc(100dvh - <topbar 56px or 0>px - <panel height or 32 when collapsed>px)`
  whenever the panel shows, collapses or resizes; dispose restores
  `calc(100dvh - 56px)` with a topbar, `100dvh` without, and removes the panel.

## Testing

Component tests with a real iframe in happy-dom: hidden until first
violation, badge count, entry text for `api` and `details` (markup in the
fields stays text), messages from other sources and other types ignored,
collapse/expand, iframe height on show and collapse, dispose. Typecheck,
lint, tests; the functional suite is unaffected (the panel only exists in
`VITE_SANDBOX_CHECKER` builds).

## Done when

The panel renders from `@dotli/ui/components/sandbox-checker/`,
`sandbox-checker-ui.ts` is gone, `bridge.ts` imports the new module, and all
checks pass.
