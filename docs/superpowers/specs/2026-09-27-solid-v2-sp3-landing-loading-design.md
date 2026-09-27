# Solid v2 migration: sub-project 3 (landing page, loading screen, `activateHost` root disposers)

Status: written by the controller under the owner's standing instructions ("go with your recommendation for SP3 and SP4", "continue, I'm still AFK").

This spec follows the owner's rulings:
- Error pages stay imperative, on both host and sandbox.
- The sandbox gets no Solid at startup.
- SP3 runs after SP4.
- The +25 KB host limit still applies.
- Performance checks run only at the end of the sub-project (2026-09-27).

Parent: `2026-09-25-solid-v2-ui-migration-design.md`, including its Roots table.

The inventory was taken at 17bb7a79. It lives in the controller scratchpad and is copied into the plan workspace.

## Goal

Three changes:
- The landing page becomes a lazily loaded Solid root.
- The loading screen becomes a Solid island, driven by a Solid-free loading store.
- `activateHost` and the error pages dispose tracked app roots instead of pruning `#app` children or overwriting live roots.

The rules that bound this work:
- `packages/ui/src/ui.ts` keeps only the error pages and small shared helpers. It stays Solid-free, because the sandbox imports `showError` from it.
- There is no visible change, apart from fixing the `no_content` timer leak.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | App-root registry | New Solid-free module `packages/ui/src/mount/app-roots.ts`, exporting `registerAppRoot(name: "loading" \| "page", dispose)`, `disposeAppRoot(name)` and `disposeAppRoots()`. Disposing is idempotent.<br>• `activateHost` (`bridge.ts:1255-1272`) calls `disposeAppRoot("page")`, and also calls `disposeAppRoot("loading")` unless the loading element is retained. That retention case is the first `renderAppSubdomain`, where the overlay stays until the sandbox reports done.<br>• The blanket `#app` child-pruning loop is replaced, keeping only the removal of stray non-root children that exist today (verify which).<br>• `showErrorPage` and `showNoContentError` call `disposeAppRoots()` before their `innerHTML` write. That one-line change to otherwise-imperative error code fixes the leaked loading timers on the `no_content` path |
| 2 | Loading store and controller | The loading logic in `ui.ts` (lines 26–653: phases, crawl, floor creep, stage narration, typewriter, stall watch, warning, sandbox-status listener, dismiss) moves into a Solid-free `packages/ui/src/loading-controller.ts`. It writes a `state/loading.ts` store: `{ progress, statusText, srText, warning: string \| null, phase: "active" \| "dismissing" \| "gone" }`.<br>`main.ts` keeps calling the same functions with the same names and signatures, re-exported from `ui.ts` or imported from the new module (update the imports). All timing behaviour is unchanged |
| 3 | Loading island | The static `.loading` markup stays in `apps/host/index.html`, so it is still the no-JS first paint, along with its inline spinner script. It gains `id="app-loading"`.<br>`components/shell/LoadingScreen.tsx` renders the same markup from the loading store and is swapped in by the islands chunk. The chunk is fetched at boot. The swapped island reads the store's current value on mount, so progress made before the mount appears at once.<br>Dismiss: `phase: "dismissing"` adds the fade, then after 300 ms the root is disposed. The island registers itself as the `"loading"` app root. Before it mounts, a Solid-free fallback registered by the controller removes the static node on dispose.<br>This is lazy, not prerender + hydrate as the umbrella's Roots table says. The reason is the same one as the 4b Amendment (decision 14): reactive markup hydrated eagerly costs startup bytes |
| 4 | Landing root | The landing page (`showLanding` and its helpers, `ui.ts:843-1127`) moves into `components/landing/` (`Landing.tsx`, `RecentPills.tsx`, `NavForm.tsx`). A lazy loader, `packages/ui/src/landing/load.ts` (`showLanding(): Promise<void>`), follows the pattern in `overlays/load.ts`: it is memoized and never rejects.<br>**Mounting:** it creates `#app-view` inside `#app` and mounts it with `mountRoot("page", …)`, registered as the `"page"` app root. It also disposes the `"loading"` root, because landing replaces the loading overlay as today.<br>**If the chunk fails to load,** it shows `showError` with a reload action.<br>**Behaviour stays the same:** the typewriter placeholder, the name form with validation and inline error, no autofocus, recents loaded from the shared store with the localStorage fallback, pill removal by click and long-press, `#topbar` set to `display: none`, and the `#app` margin and height styles.<br>**Node moves:** `#auth-button`, `#theme-toggle` and `#theme-popover` are still moved into `#landing-auth` by id, whatever their current parent. That keeps the islands' by-id swap working in either mount order.<br>**Listener fix:** the document-level `pointerdown` listener is removed on dispose |
| 5 | `ui.ts` after SP3 | Keeps `showErrorPage`, `showError`, `showNoContentError`, `renderErrorText`, `SETTINGS_GLYPH`, `dotUrl` (if landing does not own it) and `prefersReducedMotion` (if still shared). Loading and landing code are gone. It stays Solid-free. The sandbox bundle must not change beyond ±50 B |
| 6 | Order of boot | No change to `main.ts` control flow. Branch C calls `void showLanding()`. Branch D calls the loading functions as today |
| 7 | Tests | • Unit tests for `app-roots`, including idempotent dispose and the call order in `activateHost` and the error pages.<br>• Loading-controller tests using fake timers, porting `progress-stall.test.ts` onto the store instead of a static DOM fixture.<br>• `LoadingScreen` swap and render tests.<br>• `Landing` component tests: form validation, no autofocus, recents render and removal, long-press, node moves in both orders relative to the islands, and the listener removed on dispose.<br>• Playwright: `ui-smoke.spec.ts` (landing pills, submit, the no-JS test) and `loading.spec.ts` pass unchanged. They run only in the final verification |
| 8 | Budget | Host startup must stay ≤ 91,500 B gzip, and under the owner's limit of 100,249 B. The loading and landing rendering code leaves the startup path. The loading controller stays on it. Measure only in the final verification task |

## Done when

- Landing and loading render from Solid roots.
- `activateHost` and the error pages dispose tracked roots.
- `ui.ts` holds only the error pages and shared helpers.
- All tests and gates pass, and the results are recorded in `docs/perf/solid-migration-baseline.md`.
