# Solid v2 SP4d: frame layout, autohide, chains, settings, "more" flyout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the product iframe's geometry a single owner, fix autohide, and turn the chains, settings (with diagnostics) and "more" pieces into lazy islands. At the end, `topbar.ts` holds only boot wiring.

**Architecture:**
- Solid-free modules stay eager: `product-frame-layout.ts`, `settings-actions.ts`, the block source, `state/network.ts`, `state/settings.ts`, and autohide.
- Components live in `packages/ui/src/components/shell/`. They are mounted by `islands.tsx` `mountIslands()` and swapped in for the static `Shell.tsx` nodes by id. This is the 4b pattern.

**Tech Stack:** Solid 2 RC, Vitest (`ui` project), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-26-solid-v2-sp4d-topbar-rest-design.md`. The inventory has line references at 07463e3d: `scratchpad/sp4d-inventory.md` in the controller's scratchpad, copied into the plan workspace.

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push.
- `Shell.tsx` and the fidelity fixture must not change. Rendered popover content must match the old DOM builders (`git show 07463e3d:packages/ui/src/topbar.ts`): ids, classes, `aria-*`, titles, copy, SVGs and `.open` toggling.
- Non-UI code never imports `solid-js`. Controllers, stores and actions are Solid-free and eager. Islands read the current store value when they mount.
- Island components live in `packages/ui/src/components/shell/`, use native listeners only (enforced by the ESLint `on*` rule), and are mounted with `mountIsolated`.
- Product-derived strings render as JSX text. Trusted host SVG may use `innerHTML` with `// eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code`.
- Solid idioms: callback refs; `untrack(() => props.x)` for one-time reads; `String(n)` for numeric text; `eqeqeq`; `flush()` only from event, rAF or timer callbacks. No Solid dev warnings: check with `cd packages/ui && NODE_OPTIONS=--no-experimental-webstorage bunx vitest run --reporter=default --silent=false`.
- Every commit passes `bun run typecheck`, `bun run lint`, `bun run test`, and `bunx prettier --check` on changed `.ts`/`.tsx` files.
- Host startup must be ≤ 94,177 B at every commit. Measure with `VITE_NETWORKS=paseo-next-v2,previewnet bun run build` followed by `bun scripts/eager-path-size.ts apps/host/dist`, and report the figure in each task.
- Playwright `apps/host/tests/functional/ui-smoke.spec.ts` runs after the build in any task that changes UI. Free port 5173 and kill any stale preview server first.

## Review Focus

1. **Product reload with chat open.** The iframe must keep its chat-narrowed width and still respect safe-area insets. Pinned in Task 1.
2. **Chains popover and autohide.** While the chains popover is open or focused, the topbar must not auto-hide, and Alt+Shift+T must not hide the bar under the open popover. Pinned in Task 2.
3. **Pending ticker cleanup.** The ticker must stop when the chains popover closes, or when its island unmounts or errors. Pinned in Task 3.
4. **Settings Save & Apply.** It must persist exactly what the old code persisted, and clear exactly the caches it cleared. "Clear all caches" must still keep the theme key. Pinned in Task 4.
5. **Mobile access through "more".** Every "more" row must reach its target before and after the swap. Focus must fall back to `#more-button` when the trigger is hidden. Pinned in Tasks 4 and 5.

---

### Task 1: product-frame-layout.ts

**Files:**
- Create `packages/ui/src/product-frame-layout.ts` and its test `packages/ui/tests/product-frame-layout.test.ts`.
- Modify:
  - `packages/ui/src/bridge.ts` (`applyIframeStyling` at ~425–431, and its callers at ~1036 and ~1207): call `attachProductFrame(iframe)`.
  - `packages/ui/src/topbar-autohide.ts`: replace `applyAppFrameGeometry` (95–117) and its callers with `setTopbarLayout`.
  - `packages/ui/src/chat/panel.ts`: replace `adjustIframe` (22–30) with `setChatWidth(open ? width : 0)`.
  - Tests `packages/ui/tests/topbar-autohide.test.ts` and `packages/ui/tests/chat-panel.test.ts`: assert the same visible geometry through the new module.

**The module.** It is a Solid-free singleton with state `{ frame: HTMLIFrameElement | null; topbarOffset: boolean; topbarShown: boolean; transition: string; chatWidth: number }` and this API:
- `attachProductFrame(iframe)` sets the reset styles and writes everything.
- `setTopbarLayout({ offset, shown, transition })`.
- `setChatWidth(px)`.
- `resetProductFrameLayout()`, for tests only; document it as such.

**Computation.** It starts from `productIframeBox({ topbarOffset })` (`packages/ui/src/product-iframe-box.ts`). Copy the exact `top`, `height`, `transform` and `transition` semantics from `applyAppFrameGeometry`, including reduced motion and the `appFrameTracking` rule. `width` is the box width minus `chatWidth` px, or the box width itself when `chatWidth` is 0. All properties are written together on every change.

**Tests:**
- Topbar hide and reveal.
- Chat open, resize and close.
- A product reload (`attachProductFrame` again) with chat open keeps the narrowed width.
- The safe-inset terms are present in the width.
- Reduced motion drops the transition.
- A write before any frame is attached is kept and applied on attach.

- [ ] Write the tests first, then implement. Run the checks and commit: `fix(ui): give the product iframe geometry one owner`.

### Task 2: Autohide fixes

**Files:** modify `packages/ui/src/topbar-autohide.ts` and its test `packages/ui/tests/topbar-autohide.test.ts`.

- Add `chains-popover` to `TOPBAR_SURFACE_IDS` and `OPEN_SURFACE_IDS`.
- Store the `focusout` `setTimeout(syncFocus, 0)` (~321–327) in a variable. Cancel it in `cancelHide`, `pinTopbarVisible` and `disposeTopbarAutoHide`.

**Tests:**
- Focus inside an open `#chains-popover` keeps the bar shown.
- An open `#chains-popover` makes Alt+Shift+T defer.
- A focusout followed by dispose does not run `syncFocus`.

- [ ] Write the tests first, then implement. Run the checks and commit: `fix(ui): keep the topbar up while the chains popover is open`.

### Task 3: Chains island

**Files:**
- Create `components/shell/ChainsPopover.tsx`. Move the pure formatters (`describeBlockDelay`, `formatSize`, `formatRate`, `stripCapacity`, `describeLiveNetwork`) next to it, or into a small `chains-format.ts`.
- Create a Solid-free `packages/ui/src/block-source.ts` holding `createBlockSource`, moved unchanged.
- Test `packages/ui/tests/components/shell/chains-popover.test.tsx`, plus swap cases in `islands.test.tsx`.
- Modify:
  - `islands.tsx`, and `load-islands.ts` (add `#chains-button` to `TRIGGERS`).
  - `topbar.ts`: delete `renderChainsPopover`, `initChainsPopover`, `slideStrip`, `stopPendingTicker`, the formatters and their globals. `initTopBar` keeps `setBlockSource(createBlockSource())` and calls `startNetworkStore()`.
  - `setChainsButtonVisible` stays exported with the same behaviour before mount. It writes the store and the static button's `hidden`, and the island reads the store on mount.
  - `chains-bars.test.ts` is rewritten against the component.

**Behaviour.** Everything the old `renderChainsPopover` did stays the same:
- The status verdict and tone.
- Per-chain rows with bar strips sized by `stripCapacity`, and the slide animation when new bars land (`.is-new` removed on `animationend`).
- Peer counts.
- Pending cells driven by a 250 ms ticker that runs only while the popover is open and stops on close, unmount or error.
- The transfer footer, hidden once the product has loaded.
- Tips.

The data comes from `networkStore`. If the store lacks a field the old code read from `network-monitor.ts`, extend `state/network.ts` rather than reading the monitor directly.

The popover uses `createPopover({ trapFocus: true })`. `aria-haspopup`, `aria-controls` and `aria-expanded` are rendered.

**Tests:**
- Markup parity for each network status.
- Bars update from the store.
- The ticker stops on close and on unmount (use fake timers).
- The transfer footer hides after product load.
- Escape and outside click close the popover.
- A blocking modal closes it.
- An early click is replayed.
- Visibility is set before mount.

- [ ] Write the tests first, then implement. Build, run Playwright and the checks, and commit: `feat(ui): render the chains popover with Solid`.

### Task 4: Settings and diagnostics island

**Files:**
- Create:
  - `components/shell/SettingsPopover.tsx`, `components/shell/Diagnostics.tsx`, and a `SettingsRows.tsx` for the radio and toggle rows if that helps.
  - A Solid-free `packages/ui/src/settings-actions.ts`. It takes these from `topbar.ts`, moved unchanged: `applyAndReset`, `wipeOriginState`, `deleteAllIndexedDBs`, `deleteAllCacheStorage`, `unregisterAllServiceWorkers`, `PRESERVED_KEYS`, `formatDiagnosticsReport`, `buildBaseDiagnosticsRows`, `collectSmoldotInfo`, `queryFinalizedBlock`, `summarizeUserAgent`, `buildLightClientVersionLabel`, `shortSha`, `formatBlock`, `backendLabel`, `isTruapiDebugEnabled`.
  - Tests `packages/ui/tests/components/shell/settings-popover.test.tsx` and `packages/ui/tests/settings-actions.test.ts` (or keep `wipe-origin-state.test.ts` pointing at the new module).
- Modify:
  - `apps/host/src/main.ts`: import `wipeOriginState` from its new home, or keep a re-export from `topbar.ts`. Prefer updating the import.
  - `islands.tsx`, and `load-islands.ts` (add `#mode-button` to `TRIGGERS`).
  - `topbar.ts`: delete `initModeToggle`, `setModePopoverOpen`, `renderModePopover`, `renderDiagnostics`, the row builders, `trapPopoverFocus`, `FOCUSABLE_SELECTOR` and the mode globals.
  - The `topbar.test.ts` mode-popover tests move to the component tests.

**Behaviour.** Everything the old `renderModePopover` and `renderDiagnostics` did stays the same:
- Sheet header and close (mobile).
- Network radios, transport radios and cache toggles, with focus kept on the checked radio after a change.
- "Clear all caches", which calls `applyAndReset(..., { forceFullWipe: true })`.
- The diagnostics rows, with click-to-copy and a 1 s "Copied" flash.
- The live RPC AssetHub row, using a lazy import of `@dotli/resolver/rpc-resolve` under `rpc-gateway`.
- Light-client info and package versions.
- "Share diagnostic", which opens the prefilled GitHub issue.
- Debug mode, which reloads with `?debug=on/off`.
- The Save & Apply footer with dirty tracking.

Persisted values come from `settingsStore`. The draft state is local to the component.

The popover uses `createPopover({ trapFocus: true })` plus the backdrop. Focus restore falls back to `#more-button` through `focusTrigger`. The component renders `aria-haspopup`, `aria-controls` and `aria-expanded`, as `initModeToggle` set them.

**Tests:**
- Markup parity for the sections.
- Dirty tracking enables Save & Apply, and Save & Apply calls `applyAndReset` with the draft (mock the actions module).
- "Clear all caches".
- Copy flash.
- Share URL content.
- Debug toggle.
- Focus restore to `#more-button` when opened from the More row.
- Early click is replayed.
- A blocking modal closes the popover.
- `settings-actions` keeps the theme key on wipe.

- [ ] Write the tests first, then implement. Build, run Playwright (`host-settings.spec.ts` too, which seeds settings) and the checks, and commit: `feat(ui): render the settings and diagnostics popover with Solid`.

### Task 5: "More" flyout island and topbar.ts clean-up

**Files:**
- Create `components/shell/MoreMenu.tsx` and its test `packages/ui/tests/components/shell/more-menu.test.tsx`.
- Modify:
  - `islands.tsx`, and `load-islands.ts` (add `#more-button` to `TRIGGERS`).
  - `topbar.ts`: delete the More wiring (~101–125), the shared outside-click closer (~129–147), the `dotli:blocking-modal-active` handler (~168–176) and `getElement` if it becomes unused. `initTopBar` is left with only boot wiring (spec decision 7).
  - `islands.test.tsx` and the permissions and theme tests that emulated the More row now use `MoreMenu`.

**Behaviour:**
- `#more-popover` rows forward `.click()` to `document.getElementById(dataset.target)` at click time, then close the flyout.
- `#more-row-chat` visibility follows the chat button, as it does today (find where this is set today and keep it working).
- The flyout uses `createPopover`.
- Clicking the button toggles the flyout.
- Outside click and Escape close it.
- A blocking modal closes it.

**Tests:**
- Each row reaches its target island, both before (through the replay) and after it mounts.
- The flyout closes after forwarding.
- Escape and outside click close it.
- A blocking modal closes it.
- Early click is replayed.
- `topbar.ts` exports and wiring shrink; `initTopBar` still starts the auth controller, block source, network store, chat panel, theme and home link. Keep a test for that.

- [ ] Write the tests first, then implement. Build, run Playwright and the checks, and commit: `feat(ui): render the more flyout with Solid and slim topbar.ts to boot wiring`.

### Task 6: Verify

- [ ] Build (`VITE_NETWORKS=paseo-next-v2,previewnet bun run build`) and run the whole functional suite in the background, with port 5173 freed and any stale preview server killed. Expect 43 passed and 2 skipped or better. Read the e2e selectors to confirm they still match.
- [ ] Measure sizes against the end of 4c (07463e3d, built in a temporary worktree):
  - Host startup must be ≤ 94,177 B, and the running total must stay under +25,600 B over the pre-migration 74,649 B.
  - Sandbox must be unchanged (±50 B).
  - Report the lazy islands chunk size and apply spec decision 9: if the chunk is over 20 KB gzip, report it as a finding instead of splitting it yourself.
- [ ] Cold start, 20-run A/B: `Host total` must be at most +5%.
- [ ] Record an "After sub-project 4d" section in `docs/perf/solid-migration-baseline.md`, and commit: `docs(perf): record sub-project 4d sizes and cold start`.
