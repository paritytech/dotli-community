# Solid v2 SP3: landing page, loading screen, activateHost root disposers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- The landing page becomes a lazy Solid root.
- The loading screen becomes a Solid island, driven by a Solid-free store.
- `activateHost` and the error pages dispose tracked app roots.
- `ui.ts` is left holding only the error pages.

**Architecture:**
- Solid-free modules are eager: `mount/app-roots.ts`, `loading-controller.ts`, `state/loading.ts`, and the landing loader.
- The components live in `components/shell/LoadingScreen.tsx`, mounted by the islands chunk, and in `components/landing/*`, which is its own lazy chunk mounted into `#app-view`.

**Tech Stack:** Solid 2 RC, Vitest, Playwright (final task only).

**Spec:** `docs/superpowers/specs/2026-09-27-solid-v2-sp3-landing-loading-design.md`. The inventory (line refs at 17bb7a79) is in the plan workspace as `inventory.md`.

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push.
- Markup, ids, classes, `aria-*`, copy and SVGs of the landing page and the loading screen stay unchanged. The one addition is `id="app-loading"` on the static `.loading` element. Compare against `git show 17bb7a79:packages/ui/src/ui.ts` and `git show 17bb7a79:apps/host/index.html`.
- `ui.ts` and every non-UI module never import `solid-js`, because the sandbox imports `showError` from `ui.ts`. Error pages stay imperative; the only change there is the `disposeAppRoots()` call.
- Components use native listeners, not Solid-delegated `on*` events (the ESLint rule enforces this in `components/shell/**`, and landing components follow the same rule). They render product and user strings as JSX text.
- Solid idioms:
  - callback refs;
  - `untrack(() => props.x)` for one-time reads;
  - `String(n)` for numeric text;
  - `eqeqeq`;
  - `flush()` only from event, rAF or timer callbacks;
  - no Solid dev warnings. Check with `cd packages/ui && NODE_OPTIONS=--no-experimental-webstorage bunx vitest run --reporter=default --silent=false`.
- Every commit passes `bun run typecheck`, `bun run lint` and `bun run test`, plus `bunx prettier --check` on changed files.
- **Per the owner's instruction, tasks 1–4 do NOT run size builds, Playwright or cold start.** Only Task 5 does.

## Review Focus

1. **Loading timers stop on every exit path:** dismiss, error page, the `no_content` page, landing, and `activateHost`. Pinned in Tasks 1 and 2.
2. **Progress made before the loading island mounts appears at once when it mounts.** It must not reset to 0% or restart the typewriter. Pinned in Task 3.
3. **The landing page's auth and theme controls end up visible in `#landing-auth`** whether the islands mount before or after the landing root. Pinned in Task 4.
4. **Typed names never reach the DOM as markup.** Invalid input shows the inline error, and a recent label containing markup renders as text. Pinned in Task 4.
5. **The sandbox stays unchanged,** with no Solid in its bundle. Pinned in Task 5.

---

### Task 1: App-root registry and disposers in activateHost and the error pages

**Files:**
- Create `packages/ui/src/mount/app-roots.ts` and `packages/ui/tests/mount/app-roots.test.ts`.
- Modify `packages/ui/src/bridge.ts` (`activateHost`, ~1255–1272, and the `.loading` re-append in `renderAppSubdomain`, ~1160–1167).
- Modify `packages/ui/src/ui.ts`: `showErrorPage` and `showNoContentError` call `disposeAppRoots()` first. The loading code registers a `"loading"` root on `initPhases` whose dispose runs `stopStatusTick()`, stops the stall watch, and removes the `.loading` element.
- Add bridge and ui tests.

**API:** `registerAppRoot(name, dispose)` replaces any earlier registration, and disposes it if it is still live. `disposeAppRoot(name)` and `disposeAppRoots()` are both idempotent.

**activateHost:**
- It disposes `"page"`, then disposes `"loading"` unless the loading element is in `retainedChildren`.
- The DOM-scan pruning is removed. If a test or code path proves that other stray `#app` children exist, remove them explicitly, name them in a comment, and keep that.

**Tests:**
- Dispose is idempotent.
- `activateHost` disposes the page root.
- It keeps the retained loading element and disposes it otherwise.
- `showNoContentError` stops the loading timers: use fake timers and assert no crawl ticks after it runs.
- `showErrorPage` disposes both roots.

- [ ] Tests first; implement; checks; commit `refactor(ui): dispose tracked app roots instead of pruning #app`.

### Task 2: Loading controller and store

**Files:**
- Create `packages/ui/src/loading-controller.ts` and `packages/ui/src/state/loading.ts`.
- Modify `ui.ts`: remove the loading code, and re-export the same public names from the controller so existing imports keep working. Or update the imports in `apps/host/src/main.ts`; do one or the other, not both.
- Port `packages/ui/tests/progress-stall.test.ts` to the store, and add `packages/ui/tests/loading-controller.test.ts`.

**Move unchanged:** `initPhases`, `advancePhase`, `nudgePhaseProgress`, `releasePhaseProgress`, `setLoadingStage`, `setLoadingWarning`, `onProgressStall`, `stopStatusTick`, `setLoadingDomain`, `listenForSandboxStatus`, `onSandboxDone`, `dismissLoading`, and their internals: crawl, floor creep, typewriter, rotation and stall watch. Replace their DOM writes with store writes:
- `progress` (0–100);
- `statusText` (the typewriter's current visible text) and `srText`;
- `warning` (string | null);
- `phase` (`"active"` | `"dismissing"` | `"gone"`).

**Interim renderer:** keep an imperative renderer, subscribed to the store, that writes the same DOM as today. It is temporary until Task 3, so the app keeps working. The `"loading"` app root from Task 1 now disposes through the controller.

**Tests** (fake timers):
- Crawl and floor creep.
- Stage rotation never repeats the opening line.
- Coalesced typewriter messages.
- The stall watch fires.
- The reduced-motion path is instant.
- Dismiss sets `"dismissing"` and then `"gone"` after 300 ms.
- The sandbox done message dismisses, and is origin-gated.

- [ ] Tests first; implement; checks; commit `refactor(ui): drive the loading screen from a Solid-free store`.

### Task 3: Loading island

**Files:**
- Create `components/shell/LoadingScreen.tsx` and `packages/ui/tests/components/shell/loading-screen.test.tsx`.
- Modify `apps/host/index.html` (add `id="app-loading"` to `.loading`), `islands.tsx` (mount it), and the loading controller (delete the interim renderer).
- Register the island as the `"loading"` app root on mount. Its dispose disposes the Solid root and removes the node.

**Markup:** exactly today's markup, rendered from the store:
- the petal logo SVG;
- the progressbar with `aria-valuenow`, the fill width and the percentage text;
- `#status` (`aria-hidden`) and `#status-sr` (`aria-live`);
- the warning row with its `.visible` class.

The `dismissing` phase applies today's fade: whatever `dismissLoading` did, class or style. Check the CSS.

**Spinner:** the inline spinner script in `index.html` animates the static SVG. After the swap, keep the petal animation working, either by porting the rAF spinner into the component with `onCleanup`, or by calling `window.__stopLoadingSpinner?.()` and running the same loop. It must respect reduced motion.

**Tests:**
- The swap happens in place.
- One element per id.
- Store state set before mount renders on mount: progress, status and warning, with no reset.
- Store updates drive the DOM.
- The dismiss fade runs, then the node is removed and the root disposed.
- Error-page dispose removes it.
- The spinner stops on dispose.

- [ ] Tests first; implement; checks; commit `feat(ui): render the loading screen with Solid`.

### Task 4: Landing root

**Files:**
- Create `components/landing/Landing.tsx`, plus `NavForm.tsx` and `RecentPills.tsx` if they help.
- Create `packages/ui/src/landing/load.ts`, and tests in `packages/ui/tests/components/landing/*.test.tsx` and `packages/ui/tests/landing/load.test.ts`.
- Modify `ui.ts` (delete the landing code: `showLanding`, `animateLandingPlaceholder`, `renderRecentPills`, `bindRecentRemoval`, the placeholder names, and `dotUrl` if only landing uses it) and `apps/host/src/main.ts` (import `showLanding` from the loader; Branch C calls `void showLanding()`).
- Update `theme-toggle.test.tsx` and `islands.test.tsx` to use the real landing component instead of simulating the node move by hand.
- Extend the ESLint `on*` rule's files glob to `components/landing/**`.

**The loader:**
- It is memoized and never rejects.
- It imports the chunk, creates `#app-view` in `#app` (keep the `#app` inline styles: `marginTop: 0`, `minHeight: 100dvh`), hides `#topbar` (`display: none`), disposes `"loading"`, then mounts `mountRoot("page", appView, Landing)` and registers it as `"page"`.
- If the chunk fails, it reports once to Sentry and calls `showError` with a reload action.

**Landing** behaves exactly as `ui.ts:915-1127` at 17bb7a79:
- The same markup.
- The typewriter placeholder, with a reduced-motion fallback, stopping on dispose.
- The form: strip the typed TLD, validate with `validateDotLabel`, show the inline error with `aria-invalid` and the error class, clear it on input, and navigate with `window.location.href = dotUrl(name)`.
- No autofocus.
- Recents come from `loadRecentLabels()`. The shared store falls back to localStorage.
- Pills render with hrefs, and removal by click calls `forgetRecentLabel`.
- On touch, a long press (450 ms) reveals the remove button, and a document `pointerdown` clears it. That listener is removed on dispose.
- On mount, `#auth-button`, `#theme-toggle` and `#theme-popover` are moved into `#landing-auth` by id.

**Tests:**
- Markup parity.
- An invalid name shows the error, and a valid one navigates. Stub `location`.
- No autofocus.
- Recents render; a label containing markup renders as text.
- Removal works, including the long press.
- The document listener is removed on dispose.
- The node move works whether the islands mount before or after.
- A chunk failure shows the error page.
- `activateHost` or the error page disposes the landing root.

- [ ] Tests first; implement; checks; commit `feat(ui): render the landing page with Solid`.

### Task 5: Verify

- [ ] Build with `VITE_NETWORKS=paseo-next-v2,previewnet bun run build`, then run the full functional suite (`bun run test:functional` in `apps/host`) in the background. Free port 5173 first and kill any stale preview server. Expect 43 passed and 2 skipped or better. Confirm the e2e selectors still match by reading them.
- [ ] Measure sizes against the end of 4d, building 17bb7a79 in a temporary worktree:
  - host startup ≤ 91,500 B, and under the owner's 100,249 B limit;
  - sandbox unchanged (±50 B), with no Solid in it (check the sourcemap sources);
  - report the landing chunk and the islands chunk.
- [ ] Cold start, 20-run A/B: `Host total` must be at most +5%.
- [ ] Record an "After sub-project 3" section in `docs/perf/solid-migration-baseline.md`, and commit `docs(perf): record sub-project 3 sizes and cold start`. The perf doc has an uncommitted table re-alignment that is not ours: commit only your own section. `git add -p` is interactive, so do this instead:
  1. Save the stray diff with `git diff docs/perf/solid-migration-baseline.md > <scratchpad>/perf-realign.patch`.
  2. `git checkout` the file.
  3. Add your section and commit it.
  4. Re-apply the saved diff with `git apply <scratchpad>/perf-realign.patch`, leaving it uncommitted.
  5. Report what you did.
