# Solid v2 SP5b — truapi-debug panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the TrUAPI debug panel's behaviour with a characterization suite, then render the panel with Solid components while keeping every behaviour, the timeline/resolution renderers and the list's anti-jank properties.

**Architecture:** Characterization tests drive `setupTruapiDebugPanel` through a single import indirection so the same suite runs against the old and new implementations. Solid-free helpers are extracted from `packages/truapi-debug/src/panel.ts` into the package first (no behaviour change). Solid components under `packages/ui/src/components/truapi-debug/` then replace the DOM building and wiring; the timeline and resolution views and the detail-pane HTML builders are called through refs.

**Tech Stack:** Solid 2 RC, Vitest 5 + happy-dom, TypeScript 6 strict, `nanoevents` debug bus.

**Spec:** `docs/superpowers/specs/2026-09-25-solid-v2-sp5b-truapi-debug-design.md`. Required reading for every task: `packages/truapi-debug/DEBUG_PANEL.md`.

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push.
- `@dotli/truapi-debug` must not import `@dotli/ui` (dependency cycle). Solid components live in `packages/ui/src/components/truapi-debug/`.
- `packages/truapi-debug/src/{event-store,dotli-debug-bus,dotli-debug-types,timeline,timeline-layout,resolution-view,chain-decode,chain-summary,chain-registry,system-summary,system-explanations,filters,format,pending,export,shape}.ts` keep their behaviour; only additive, Solid-free changes (for example a store snapshot accessor) are allowed.
- The frozen contract in the spec (markup, classes, titles, storage keys, ticks, clamps, keyboard, iframe geometry, early buffer) must hold; the characterization suite is its executable form.
- Every product/network value rendered through `innerHTML` goes through `escapeHtml` (`@dotli/shared/html`), as today; anything rendered through JSX is text.
- Solid 2 idioms in this repo: callback refs (ESLint `no-unassigned-vars`), `untrack(() => props.x)` for deliberate one-time reads (avoids the `STRICT_READ_UNTRACKED` dev diagnostic), `createEffect(compute, effect)`, `<For keyed={(x) => key}>`, `String(n)` for numeric text children, `eqeqeq: always`.
- Every commit passes `bun run typecheck`, `bun run lint`, `bun run test`; `bunx prettier --check` on changed `.ts`/`.tsx`.

## Review Focus

1. Streaming load: many events per frame must not drop an in-flight click on a list row or reset timeline hover (the reasons today's renderers are imperative). Pinned in Task 1 (click during burst) and Task 3.
2. Paused store: events emitted while paused must not appear, and must not feed the resolution recorder. Pinned in Task 1.
3. Dispose must restore the iframe layout and remove every listener and timer (pending tick, resolution tick, rAF). Pinned in Task 1.
4. Detail pane: payload strings containing markup render as text. Pinned in Task 1.
5. Capacity: past 2000 events the oldest are pruned from the list and the "dropped" count reflects it. Pinned in Task 1.

---

### Task 1: Characterization suite for today's panel

**Files:**
- Create: `packages/ui/tests/truapi-debug/panel-entry.ts` (the single import indirection)
- Create: `packages/ui/tests/truapi-debug/panel.test.ts`

**What to build:** `panel-entry.ts` exports `loadPanel(): Promise<{ setupTruapiDebugPanel: (options?: { capacity?: number; startCollapsed?: boolean }) => () => void }>`, implemented today as `import("@dotli/truapi-debug/panel")`. Every test obtains the panel only through it (Task 3 changes this one line).

The suite (Vitest + happy-dom, repo test style "As a dotli developer, …", Given/When/Then comments) must read `DEBUG_PANEL.md` and `panel.ts` and pin, at minimum:
- mount creates `#truapi-debug-panel` with the header controls, filters, tabs, list/timeline/resolution containers and detail pane; a second setup call is a no-op; `startCollapsed` starts collapsed; dispose removes the panel.
- events arrive through the debug bus (`emitDotliDebugEvent` / whatever `panel.ts` subscribes to for TrUAPI message events — read `isTruapiDebugEvent` and the bus wiring) and appear as list rows with the same classes, summaries and counts; early events emitted after `enableDotliDebugBuffering()` but before setup are shown.
- pause stops new rows (and does not feed the resolution view); clear empties the list and counts; export builds the filtered JSON (mock the download path) and copy writes it to the clipboard (stub `navigator.clipboard`), flashing the button.
- filters: kind checkboxes, direction chips, product chips (created per product id), include/exclude text — each hides and shows the right rows.
- selecting a row (click and ↑/↓ keys) fills the detail pane; a group/request id highlights its siblings; a payload with `<b>…</b>` shows as text in the detail pane.
- tabs switch views; the timeline renders SVG for events; the resolution view renders after its tick (use fake timers).
- dock toggle switches `docked-right`, persists `localStorage["truapi-debug:dock"]`, and a stored value is applied on the next mount.
- collapse toggles `.collapsed`; resize and body-splitter drags respect the documented clamps (happy-dom sizes: stub `offsetWidth`/`offsetHeight`/`getBoundingClientRect` where needed and say so).
- close sets `sessionStorage["dotli:truapi-debug"] = "0"` and reloads (stub `location.reload`).
- iframe geometry: with an `iframe` (and optionally `#topbar`) in the document, mounting/collapsing/docking writes `iframe.style.height`/`width` as `adjustIframeForPanel` does; `dotli:product-loaded` refits; dispose restores (`restoreIframeLayout`).
- pending badge: a request without a response shows a "+Ns" pending marker that advances with the 1 s tick in list view (fake timers).
- capacity: with `capacity: 5`, emitting 8 events leaves 5 rows and the dropped count reflects 3.
- a burst: a row clicked while more events stream in stays selected and its node is not replaced (assert node identity before and after the burst).

Where a behaviour cannot be observed in happy-dom, write the test to the closest observable effect and list it in the report. Do not change production code in this task. All tests must pass against today's panel.

- [ ] Step 1: Read `DEBUG_PANEL.md` and `panel.ts`; write `panel-entry.ts` and the suite.
- [ ] Step 2: Run `bun run --cwd packages/ui test tests/truapi-debug/panel.test.ts` — all pass. Temporarily break one behaviour in `panel.ts` (e.g. skip the dock write) and confirm the matching test fails; revert (`git diff --quiet packages/truapi-debug`).
- [ ] Step 3: `bun run typecheck && bun run lint && bun run test`; commit `test(ui): characterize the truapi-debug panel`.

---

### Task 2: Extract Solid-free helpers from panel.ts (no behaviour change)

**Files:**
- Create in `packages/truapi-debug/src/`: `detail-html.ts` (move `renderDetail`'s string builders: `renderSingleDetail`, `renderTruapiSingleDetail`, `renderSystemSingleDetail`, `renderExplanationSection/Body/Paragraph`, `formatInlineCode`, `renderSiblingsHtml`, `renderSummarySection`, `renderGroupDetail`, `renderTruapiMemberBlock`, `renderSystemMemberBlock`, `renderChainSection`, `formatTime`, `formatLatency`), `row-format.ts` (row summary helpers: `chainSummary`, `shortHex`, `ridColor`, `tagClass`, and the pure parts of `renderTruapiRow`/`renderSystemRow` as functions returning `{ className, cells… }` data rather than DOM), `iframe-layout.ts` (`adjustIframeForPanel`, `restoreIframeLayout`, taking plain `{ collapsed, dock, width, height }` input instead of the panel element where possible), `dock-storage.ts` (`readStoredDock`, `writeStoredDock`, `DOCK_STORAGE_KEY`).
- Modify: `packages/truapi-debug/src/panel.ts` to import them.
- Modify (additive): `packages/truapi-debug/src/event-store.ts` — add `version(): number` (increments on every change) so a Solid adapter can snapshot `list()` cheaply.

- [ ] Step 1: Move the helpers verbatim (keep names, keep `escapeHtml` use), export what `panel.ts` needs, keep `panel.ts` behaviour identical.
- [ ] Step 2: Add `EventStore.version()` with a unit test in `packages/ui/tests/truapi-debug/event-store.test.ts` (insert/clear/prune each bump the version; a paused insert does not).
- [ ] Step 3: The Task 1 suite passes unchanged. `bun run typecheck && bun run lint && bun run test`; commit `refactor(truapi-debug): extract Solid-free panel helpers`.

---

### Task 3: Solid panel

**Files:**
- Create `packages/ui/src/components/truapi-debug/`: `mount.tsx` (exports `setupTruapiDebugPanel(options?: { capacity?: number; startCollapsed?: boolean }): () => void` with today's contract: double-mount guard, style injection as today, creates the store and resolution recorder, subscribes to the debug bus, mounts the panel into a container appended to `body` via `mountRoot("truapi-debug", …)`, returns a dispose that unmounts, unsubscribes, clears timers and restores the iframe layout), `Panel.tsx` (root `#truapi-debug-panel` with the state previously in `PanelState` as signals), `Header.tsx`, `Filters.tsx`, `Tabs.tsx`, `EventList.tsx` (a `<For keyed={(e) => e.seq}>` over a store snapshot signal refreshed at most once per animation frame from `store.subscribe` + `store.version()`, with ↑/↓ keyboard selection and the 1 s pending tick while the list view is active), `DetailPane.tsx` (sets `innerHTML` from `detail-html.ts` through a ref, with `// eslint-disable-next-line solid/no-innerhtml -- escaped by detail-html.ts`), `TimelineView.tsx` and `ResolutionView.tsx` (call `buildTimelineContainer`/`renderSwimlanes`/`applyTimelineSelection`/`resolveTimelineClick` and `buildResolutionContainer`/`renderResolution` through refs and effects; the resolution view keeps its 500 ms tick while visible and not collapsed), `Resizers.tsx` (panel resize and body splitter with today's clamps), plus the hover tooltip behaviour from `wireHoverTooltips`.
- Modify: `packages/ui/tests/truapi-debug/panel-entry.ts` — `import("@dotli/ui/components/truapi-debug/mount")`.

- [ ] Step 1: Build the components; markup, classes, titles and copy identical to `panel.ts`'s `buildPanel` and render functions (`String(n)` for numeric text).
- [ ] Step 2: Point `panel-entry.ts` at the Solid mount. The Task 1 suite must pass unchanged; do not edit its assertions. If an assertion cannot hold, stop and report it.
- [ ] Step 3: `bun run typecheck && bun run lint && bun run test` with no `STRICT_READ_UNTRACKED` warnings from these components; commit `feat(ui): render the truapi-debug panel with Solid`.

---

### Task 4: Switch the host, remove the old panel, verify

**Files:**
- Modify: `apps/host/src/main.ts` — the debug-mode dynamic import becomes `import("@dotli/ui/components/truapi-debug/mount")` (same `setupTruapiDebugPanel({ startCollapsed: !debugMode.explicit })` call).
- Modify/Delete: `packages/truapi-debug/src/panel.ts` and `src/index.ts` — delete the DOM-building and wiring code; keep `index.ts` exporting only what still exists (or nothing). Update `DEBUG_PANEL.md` where it names `panel.ts` functions, pointing at the new component files.
- Remove `solid-js` / `@solidjs/web` from `packages/truapi-debug/package.json` and `packages/sandbox-checker/package.json` only if nothing in those packages imports them (run `bun install` to refresh the lockfile; if the lockfile change is large or touches unrelated packages, leave the dependencies and report instead).

- [ ] Step 1: Switch the import; delete the old code; `git grep -n "truapi-debug/panel" -- apps packages` returns only doc references you updated.
- [ ] Step 2: `bun run typecheck && bun run lint && bun run test`; the Task 1 suite passes.
- [ ] Step 3: `VITE_NETWORKS=paseo-next-v2,previewnet bun run build`; `bun scripts/eager-path-size.ts apps/host/dist` unchanged versus the build before this task (±50 B gzip; measure before editing); the sourcemap `sources` of every eager chunk contain no `solid-js`, `@solidjs` or `/components/`. Run the functional suite (`bun run --cwd apps/host test:functional`, in the background with a log, port 5173 freed first): 41 passed, 2 skipped. Then `VITE_APP_DEBUG=true VITE_NETWORKS=paseo-next-v2,previewnet bun run build` and confirm the debug panel chunk builds (a lazy chunk whose sourcemap `sources` contain `components/truapi-debug/mount.tsx`).
- [ ] Step 4: Commit `refactor: load the Solid truapi-debug panel and remove the old one`.
