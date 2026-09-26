# Solid v2 migration — sub-project 4d: product frame layout, autohide, chains, settings/diagnostics, "more" flyout

Status: written by the controller under the owner's standing instructions of 2026-09-26 ("go with your recommendation for SP3 and SP4", "continue, I'm still AFK").

Parents:
- `2026-09-26-solid-v2-sp4a-shell-prerender-design.md` (4a), whose "Sub-project 4 split" defines 4d.
- 4b, whose lazy islands are spec decisions 14–18.
- 4c.

Line references are to the tree at 07463e3d.

## Goal

This finishes the topbar and leaves `packages/ui/src/topbar.ts` a thin boot module. It does four things:

- **One owner of the product iframe's geometry.** A new Solid-free `product-frame-layout.ts` replaces three uncoordinated writers, which fixes the chat-width vs autohide / product-reload conflict and the missing safe-area insets.
- **Autohide fixes.** Autohide stays Solid-free and gets two fixes.
- **Three new lazy islands:**
  - the chains/network button and popover;
  - the settings ("mode") button and popover, including diagnostics;
  - the "more" flyout.
- **Deletions.** The matching imperative code, the hand-rolled `trapPopoverFocus`, and the shared outside-click closer and blocking-modal handler in `topbar.ts` all go.

There is no visible change apart from the fixes listed in decisions 2 and 3.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Frame layout owner | New `packages/ui/src/product-frame-layout.ts` (Solid-free, eager) owns the product iframe's inline geometry: `position`, `top`, `left`, `width`, `height`, `transform` and `transition`, plus the reset styles `applyIframeStyling` sets today (`border`, `margin`, `padding`).<br>**State:** `{ topbarOffset, topbarShown, chatWidth }`, where `chatWidth` is 0 when chat is closed.<br>**API:** `attachProductFrame(iframe)` replaces `bridge.ts` `applyIframeStyling` at both call sites; `setTopbarLayout({ offset, shown, transition })` is called by autohide; `setChatWidth(px)` is called by the chat panel.<br>**Behaviour:** every change recomputes all properties from `productIframeBox()` plus the chat width, and writes them together. `width` becomes `calc(<safe box width> - <chatWidth>px)`, so chat now respects `--safe-left`/`--safe-right`. A product reload keeps the chat-narrowed width.<br>Inventory §4 lists the three writers. `adjustIframe` in `chat/panel.ts` and `applyAppFrameGeometry` in `topbar-autohide.ts` are deleted |
| 2 | Autohide | `topbar-autohide.ts` stays Solid-free. It is behaviour, and its only markup is the runtime reveal button.<br>**Fixes:** add `chains-popover` to `TOPBAR_SURFACE_IDS` and `OPEN_SURFACE_IDS` (inventory §7 has the pre-existing bug), and track and cancel the `focusout` `setTimeout`.<br>**Geometry** goes through `setTopbarLayout`. Timers, the hover strip, the reveal shortcut and button, and `isLoggedIn` are unchanged |
| 3 | Chains island | `components/shell/ChainsPopover.tsx` renders `#chains-button` and `#chains-popover` with today's content: the status row, per-chain block-bar strips with the slide animation, peer counts, pending-block ticker cells, the transfer footer and tips.<br>**Data:** it reads `state/network.ts` `networkStore`, and `startNetworkStore()` is now called eagerly. It also reads `state/product.ts`, which hides the transfer footer once the product has loaded.<br>**Behaviour:** the pending ticker runs only while open, with `onCleanup`. It uses `createPopover` with `trapFocus: true`, which gives it the focus restore and Escape handling the hand-rolled version lacks.<br>**Visibility:** `setChainsButtonVisible` in `main.ts` keeps working before mount. It writes `state/topbar.ts` `recordChainsButtonVisible` plus the static button's `hidden`, and the island reads the store on mount.<br>`createBlockSource` and `setBlockSource` stay eager, in a Solid-free module |
| 4 | Settings island | `components/shell/SettingsPopover.tsx` (with `Diagnostics.tsx`) renders `#mode-button`, `#mode-popover-backdrop` and `#mode-popover` with today's content and behaviour: the sheet header and close, network and transport radios, cache toggles, "Clear all caches", diagnostics rows with copy, live RPC node, light-client info, "Share diagnostic", debug mode, and the Save & Apply footer with dirty tracking.<br>**Data:** persisted values come from `state/settings.ts` `settingsStore`, which is already initialised at boot.<br>**Actions move** to a Solid-free `packages/ui/src/settings-actions.ts`: `applyAndReset`, `wipeOriginState` (still exported for `main.ts:812`), the cache wipes, `formatDiagnosticsReport` and the diagnostics row builders' data functions.<br>**Popover:** `createPopover` with `trapFocus: true`, plus the backdrop. It keeps the focus-restore fallback to `#more-button` that `trapPopoverFocus` has, which `popover.ts` `focusTrigger` already provides |
| 5 | "More" flyout island | `components/shell/MoreMenu.tsx` renders `#more-button` and `#more-popover`. Its rows forward `.click()` to their `data-target` button by id at click time, as today. It uses `createPopover`.<br>This deletes `topbar.ts`'s shared outside-click closer (129–147) and its `dotli:blocking-modal-active` handler (168–176), since every popover now closes through `createPopover`.<br>Tests use the real component instead of emulating the "More" row (a 4c carry-forward) |
| 6 | Early clicks | `#chains-button`, `#mode-button` and `#more-button` are added to `TRIGGERS` in `load-islands.ts` |
| 7 | What remains in `topbar.ts` | `initTopBar` starts the auth controller, the block source, the chat panel, the theme controller, the home link and the idle session rehydrate. `trapPopoverFocus` and all popover code are gone, and so are the focus-helper duplicates (a 4c carry-forward) |
| 8 | Markup | The static markup in `Shell.tsx` does not change, so the fidelity fixture does not change. The chains and mode popovers are empty containers in the static markup, and their content renders only in the islands.<br>Parity is checked against the old DOM builders (`git show 07463e3d:packages/ui/src/topbar.ts`). ARIA attributes that `topbar.ts` set at runtime (`aria-haspopup`, `aria-controls`, `aria-expanded` on `#mode-button` and `#chains-button`) are rendered by the islands |
| 9 | Chunking | All islands stay in one lazy chunk, fetched at boot. If that chunk exceeds 20 KB gzip after 4d, split settings and diagnostics into a second lazy chunk loaded on first open, and replay the click. Decide this in the verification task, with the numbers |
| 10 | Budget | Host startup must be at most 93,977 B + 200 B at every commit. The popover renderers leave the startup path, so startup is expected to drop. The running total must stay under the owner's +25 KB limit |
| 11 | Landing page | `ui.ts` hides `#topbar` with `display: none` on the landing page. That is unchanged: swaps work on hidden nodes, and `getElementById` still resolves them |

## Testing

- **Frame layout:** unit tests for the combined state, including topbar hide/reveal, chat open, resize and close, a product reload with chat open, safe-area insets in the width, and reduced motion. The chat-panel and autohide tests are updated to assert through the layout module.
- **Autohide:** the chains popover counts as busy and as an open surface; the focusout timer is cancelled on dispose.
- **Islands:** markup parity against the old builders, keyboard and Escape handling, outside click, blocking-modal close, the ticker cleaning up on close, the network store driving the bars, settings dirty tracking and Save & Apply calling the actions, "Clear all caches", diagnostics copy and share, the More rows forwarding clicks, early-click replay for the three triggers, and swap tests.
- **Existing tests:** `topbar.test.ts`, `chains-bars.test.ts` and `chat-panel.test.ts` are rewritten against the components and modules with the same behaviour assertions. `host-settings.spec.ts` and `network-transport.spec.ts` still pass; they seed settings rather than using the UI. The functional suite passes, and there are no Solid dev warnings.

## Performance

- Host startup: at most 94,177 B gzip, and under the owner's limit.
- Sandbox: unchanged.
- Cold start: no regression beyond 5%.
- The lazy islands chunk size is recorded, and decision 9 applies.

## Done when

- The product iframe geometry has one writer.
- Autohide is fixed.
- The chains, settings and More pieces render from islands.
- `topbar.ts` holds only boot wiring.
- All tests and gates pass, and the results are recorded.
