# Solid v2 migration — sub-project 5b: truapi-debug panel

Status: written while the owner was AFK (2026-09-25), under the standing
instruction to continue without approval stops and record decisions in
`SOLID_MIGRATION_QUESTIONS.md`. Parent: `2026-09-25-solid-v2-ui-migration-design.md`
(sub-project 5). Sibling: `2026-09-25-solid-v2-sp5a-sandbox-checker-design.md`.

## Goal

Render the dev-only TrUAPI debug panel (`packages/truapi-debug/src/panel.ts`,
1,893 lines) with Solid components, keeping its markup, behaviour, copy and
anti-jank properties, after first pinning today's behaviour with tests (the
panel has none).

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Order | Characterization tests first, written against today's `setupTruapiDebugPanel` and run unchanged against the Solid version. No port step lands without them passing |
| 2 | Location | Solid components live in `packages/ui/src/components/truapi-debug/` (`@dotli/truapi-debug` must not depend on `@dotli/ui`). The package keeps its Solid-free logic (event store, bus, decoders, summaries, filters, layout math, timeline and resolution renderers) and gains Solid-free modules extracted from `panel.ts` (detail-pane HTML builders, row formatting, iframe layout, dock storage) |
| 3 | Imperative renderers stay | The timeline (`timeline.ts`, keyed SVG reconciliation) and resolution view (`resolution-view.ts`, memoized HTML) are called from components through refs and effects, unchanged. Both were written imperatively on purpose (full rebuilds broke hover and dropped clicks under streaming load) |
| 4 | List | The event list becomes a `<For keyed>` over a snapshot of the store, keyed by event `seq`, coalesced to one update per animation frame. Keyed reconciliation keeps row nodes stable, which is what today's incremental append-and-prune achieves |
| 5 | Detail pane | Keeps today's string builders, which escape every product and network value with `escapeHtml`, rendered into the pane through a ref. Porting ~350 lines of detail markup to JSX is left for later; it would change no behaviour |
| 6 | Loading | Unchanged model: `apps/host/src/main.ts` imports the panel dynamically only in debug mode; it now imports `@dotli/ui/components/truapi-debug/mount` (same `setupTruapiDebugPanel(options)` contract). The panel stylesheet stays a lazily fetched asset |
| 7 | Dead copy | The close button's tooltip "Hide (Ctrl+Shift+D)" has no matching shortcut anywhere. Kept verbatim (no behaviour change); recorded as a question |

## Frozen contract

`#truapi-debug-panel` and every `td-*` class and structure in `panel.ts`'s
`buildPanel` template; the header controls (pause, clear, export, copy, dock,
collapse, close) and their titles; `localStorage["truapi-debug:dock"]`;
`sessionStorage["dotli:truapi-debug"] = "0"` + reload on close; the
double-mount guard; `startCollapsed`; capacity 2000; filter semantics
(`filters.ts`); list keyboard navigation (↑/↓); tabs List / Timeline /
Resolution; resize and body-splitter clamps (`MIN_PRIMARY_PX` 220,
`MIN_SECONDARY_PX` 260); the pending "+Ns" badge tick (1 s, list view only);
the resolution tick (500 ms, resolution view, not collapsed); iframe geometry
writes and their restore on dispose; `dotli:product-loaded` refit; early
buffered events from `dotli-debug-bus`.

## Testing

A characterization suite in `packages/ui/tests/truapi-debug/` drives the
public entry (`setupTruapiDebugPanel`) and the debug bus, asserting DOM and
side effects for every item in the frozen contract. It is written first
against today's panel, then pointed at the Solid entry and must pass
unchanged. Existing pure modules keep working; new Solid-free extracted
modules get unit tests only where the characterization suite does not already
cover them.

## Performance

The panel only loads in debug mode. Gate: the host startup bundle does not
change (±50 B gzip) and no Solid enters any startup chunk.

## Done when

The panel renders from `@dotli/ui/components/truapi-debug/`, the DOM-building
and wiring code in `packages/truapi-debug/src/panel.ts` is gone (the file is
deleted or reduced to re-exports), the characterization suite passes against
the Solid panel, and typecheck, lint, tests and the functional suite pass.
