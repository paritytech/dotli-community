# Solid v2 SP4c (auth button, QR pairing modal, user popover, permissions popover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the auth button, the QR pairing modal, the user popover and the permissions popover into lazy Solid islands. Their state is driven by Solid-free controllers and stores. Delete their imperative code from `topbar.ts`, and unify the `dotli:permission-changed` detail.

**Architecture:**
- Solid-free modules (`auth-controller.ts`, `state/auth-modal.ts`, and the existing `state/auth.ts` / `state/product.ts`) are loaded eagerly. They react to host events from boot onwards.
- Components in `packages/ui/src/components/shell/` render from those stores. They are mounted by `islands.tsx` `mountIslands()` and swapped in for the static `Shell.tsx` nodes by id (the 4b pattern).

**Tech Stack:** Solid 2 RC, Vitest (`ui` project), Playwright, `qrcode` (lazy import).

**Spec:** `docs/superpowers/specs/2026-09-26-solid-v2-sp4c-auth-permissions-design.md`.

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push.
- The markup of every piece stays unchanged: ids, classes, `aria-*`, titles, copy, SVGs, and the `.open` toggling. Compare with the `Shell.tsx` static markup and the old `topbar.ts` string builders (`git show 650a9df9:packages/ui/src/topbar.ts`). `Shell.tsx` and the fidelity fixture do not change.
- Selectors that must keep working:
  - the Playwright and e2e selectors: `#auth-button`, `#auth-modal-backdrop.open`, `#auth-modal-title`, `#auth-modal-close`, `#auth-modal-qr canvas`, `#user-popover-username`, `#auth-button .user-badge`;
  - the autohide id lists and `.user-badge` query in `topbar-autohide.ts`.
- Non-UI code never imports `solid-js`. The controllers and stores are Solid-free and eager. The islands read the current store value on mount.
- Island components live in `packages/ui/src/components/shell/`. They use native listeners only, and the ESLint `on*` rule enforces this. Each one is mounted with `mountIsolated` in `mountIslands()`.
- Product- and user-derived strings render as JSX text. Trusted host SVG may use `innerHTML` with `// eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code`.
- Solid idioms: callback refs, `untrack(() => props.x)` for one-time reads, `String(n)` for numeric text, `eqeqeq`, `flush()` only from event, rAF or timer callbacks, and no Solid dev warnings. Check with `cd packages/ui && NODE_OPTIONS=--no-experimental-webstorage bunx vitest run --reporter=default --silent=false`.
- Every commit passes `bun run typecheck`, `bun run lint` and `bun run test`, plus `bunx prettier --check` on changed `.ts`/`.tsx` files.
- Host startup (`VITE_NETWORKS=paseo-next-v2,previewnet bun run build`, then `bun scripts/eager-path-size.ts apps/host/dist`) is at most 96,831 B at every commit. Report it in each task.

## Review Focus

1. **A stale QR render must never replace a newer view.** For example: the phone scanned, the view moved to "Logging in...", then the `qrcode` import resolves. Pinned in Task 3.
2. **Two overlapping login requests must never both hold the blocking-modal lease.** This is the `authModalScope` identity guard. Pinned in Task 2.
3. **An auth state or login request that arrives before the islands chunk must show once the chunk mounts.** This covers boot rehydration from `SessionStore` and a `dotli:request-login` sent at boot. Pinned in Tasks 2 and 3.
4. **Escape precedence in the permissions popover.** An open row dropdown closes first, then the popover. Pinned in Task 4.
5. **A product label or username containing markup renders as text** in the badge, the popover and the modal title. Pinned in Tasks 3 and 4.

---

### Task 1: Unify the `dotli:permission-changed` detail

**Files:** modify `packages/ui/src/state/permissions.ts`, `packages/ui/src/host-callbacks/PromptPermission.ts` (~line 174) and `packages/ui/tests/state/permissions.test.ts`.

In `state/permissions.ts`:
- `PermissionChange`'s `grant` variant requires `permission`.
- `recordPermissionChange` always dispatches `{ label, permission }`.
- Update the doc comment.

In `PromptPermission.ts`, the grant call passes `permission: name`.

In the tests, replace the "grant without permission" shape test with one asserting that both call paths produce `{ label, permission }`. Add a `PromptPermission` test if one exists nearby; otherwise assert through `recordPermissionChange`.

- [ ] Tests first; implement; checks; commit `refactor(ui): always send the permission in dotli:permission-changed`.

### Task 2: Auth controller and auth-modal store (Solid-free)

**Files:**
- Create `packages/ui/src/auth-controller.ts` and `packages/ui/src/state/auth-modal.ts`.
- Tests: `packages/ui/tests/auth-controller.test.ts` and `packages/ui/tests/state/auth-modal.test.ts`.
- Modify `topbar.ts`:
  - `initTopBar` calls `initAuthController(coordinator)`;
  - the modal and auth-button rendering subscribe to the stores instead of being driven directly;
  - delete the moved logic.

**Move unchanged** from `topbar.ts` (lines as at 650a9df9) into `auth-controller.ts`:
- the lease logic: `openModal` (2897–2934), `closeModal` (2936–2954) and `ensureAuthModalLease` (2956–2997), with the `authModalScope`/`releaseAuthModal` identity guard;
- `requestTruapiLogin` and `requestTruapiDisconnect` (690–702);
- the `dotli:request-login` listener (174–179);
- the auth-state → modal-view mapping that is `renderAuthState` / `renderPairing` / `renderAuthenticating` / `renderError` today. Keep the copy functions `friendlyAuthError` and `exhaustedAllowanceError` as pure helpers.

**Store shape** for `state/auth-modal.ts`: `{ open: boolean; productLabel: string | null; reason: string | null; view: { kind: "spinner" } | { kind: "pairing"; payload: string } | { kind: "authenticating" } | { kind: "error"; message: string; retry: boolean } }`.
- The store has setters used only by the controller.
- `retry` in the error view calls a controller function (`retryLogin()`), which the component invokes.

**`topbar.ts` in this task:**
- It keeps rendering the modal and auth button imperatively, but from `authModalStore` and `authStore` subscriptions, not from the removed functions.
- This keeps the task shippable on its own; Task 3 deletes that rendering.
- Keep the imperative QR canvas code, driven by `view.kind === "pairing"`, with the last-payload-wins guard.

**Tests:**
- The lease queue, including two overlapping `openAuthModal` calls, where only the newest scope holds the lease.
- Close releases the lease and dispatches `dotli:truapi-cancel-login` exactly as today.
- Auth-state tags map to views (`Pairing`, `Authenticating`, `Connected` → close, `Disconnected`, `LoginFailed` → error copy).
- A `dotli:request-login` before any subscriber exists is reflected in the store.
- The existing `topbar.test.ts` "login cancellation" and "disconnect" blocks keep passing. Adjust only imports and setup.

- [ ] Tests first; implement; checks; commit `refactor(ui): move auth modal state into a Solid-free controller`.

### Task 3: Auth button, user popover and QR modal islands

**Files:**
- Create `components/shell/AuthButton.tsx`, `components/shell/UserPopover.tsx` and `components/shell/AuthModal.tsx`.
- Tests: `packages/ui/tests/components/shell/auth-button.test.tsx`, `user-popover.test.tsx` and `auth-modal.test.tsx`, plus swap cases in `packages/ui/tests/components/shell/islands.test.tsx`.
- Modify:
  - `islands.tsx`: add three `mountIsolated` entries;
  - `topbar.ts`: delete the auth-button, user-popover and modal DOM code and cached refs (lines 91–101 and 136–172), the user-popover branches in the outside-click closer (226–258) and the blocking-modal handler (282–292), and `setUserPopoverNoUsernameHint`, `truapiSessionInitials` and `shortenAccount` (move the pure helpers next to the components);
  - the `topbar.test.ts` auth blocks, rewritten against the components with the same behaviour assertions.

**AuthButton:**
- Reproduces the logged-out icon (`USER_SVG`), the `.user-badge` and `.user-badge-anon` variants, and title and `aria-label`, from `authStore` and `loggedInStore`.
- The static markup's `disabled`/`aria-busy` "Connecting..." state is cleared on mount, as `initTopBar` did (156–157).
- A click behaves as `handleAuthButtonClick` did: logged out → login request; logged in → toggle the user popover.
- Calls `setLoggedIn` exactly where `renderLoggedOut` and `renderTruapiLoggedIn` did. If that belongs in the controller, move it there, keeping the event order.

**UserPopover:**
- `#user-popover` with `.open`, the username text, the `#user-popover-hint` runtime row (from `setUserPopoverNoUsernameHint`), and the disconnect button calling `requestTruapiDisconnect`.
- Uses `createPopover({ trapFocus: true })` (spec decision 6), with the auth button as trigger. It closes on a blocking modal.

**AuthModal:**
- `#auth-modal-backdrop` with `.open`, `role="dialog"`, `aria-modal="true"` and `aria-labelledby="auth-modal-title"`.
- The title with `productLabel` as text.
- The reason, hint, get-app link and close button.
- A backdrop click on itself closes, as today.
- It owns the focus trap while open; reuse `createPopover` if it fits, otherwise keep a local trap equivalent to `trapPopoverFocus`.
- The QR view draws a canvas with a lazy `import("qrcode")` and the same options (`width: 200`, `margin: 2`, same colours).
- Last payload wins: a render is dropped if the view is no longer `pairing` with that payload. Use an effect cleanup, not a module global.
- Reproduce the mobile branch, the authenticating view and the error view with retry exactly.

**Tests:**
- Markup parity for every variant, against the old string builders.
- A username or product label of `<b>x</b>` renders as text.
- Stale QR: resolve `import("qrcode")` after the view changed and assert no canvas is inserted.
- Focus trap and Escape in the popover and the modal.
- Swap: the auth button moved into `#landing-auth` is swapped where it is.
- Store state set before mount is rendered on mount (Review Focus 3).
- One element per id.

- [ ] Tests first; implement; build and run Playwright `apps/host/tests/functional/ui-smoke.spec.ts` (free port 5173 and kill any stale preview server first); checks; commit `feat(ui): render the auth button, user popover and pairing modal with Solid`.

### Task 4: Permissions button, popover and dropdowns island

**Files:**
- Create `components/shell/PermissionsPopover.tsx` (button, backdrop, popover and row dropdowns; split out `PermissionRow.tsx` if it helps).
- Tests: `packages/ui/tests/components/shell/permissions-popover.test.tsx` and a swap case.
- Modify:
  - `islands.tsx`;
  - `load-islands.ts`: add `#permissions-button` to `TRIGGERS`, because the static button is enabled, so an early click must replay;
  - `state/product.ts`: the current product label must be readable from a store. Add it if missing, and have the existing `dotli:product-loaded` and `dotli:product-error` handling write it;
  - `topbar.ts`: delete `initPermissions` through `createPermissionDropdown` (732–1063), `setPermissionsPopoverOpen` (1770–1788), `PERM_ICONS` (move it), the permissions branches in the outside-click closer and the blocking-modal handler, and their cached refs;
  - the `topbar.test.ts` "topbar permissions" block, rewritten against the component.

**Behaviour** is exactly as today:
- Rows for `ALL_PERMISSIONS` with the icons and copy.
- Each row has a select-like dropdown with the same keyboard handling (arrow keys, Enter, Escape) and outside-click close.
- Choosing a value calls `setPermissionStatus` / `resetPermission` and then `recordPermissionChange` with `{ kind, label, permission }`, as at lines 895–921.
- Device permissions follow today's path.
- The error fallback text matches `renderPermissionsPopover`.
- `.has-grants` on the button follows `hasAnyGrant`.
- Re-fetch triggers and last request wins, per spec decision 7.
- `aria-controls` and `aria-expanded` are kept.
- The popover uses `createPopover({ trapFocus: true })` plus the backdrop. Escape precedence: an open dropdown consumes Escape first.
- The "more" row calling `#permissions-button.click()` works before the swap (via the replay) and after it.

**Tests:**
- Rows render per status.
- Change → API call → event with the unified detail.
- Two-level Escape.
- Outside click on the backdrop.
- Last-wins re-fetch.
- A product label containing markup renders as text.
- Early click replay.
- The "more" row.

- [ ] Tests first; implement; build and run Playwright; checks; commit `feat(ui): render the permissions popover with Solid`.

### Task 5: Verify

- [ ] Build (`VITE_NETWORKS=paseo-next-v2,previewnet bun run build`) and run the whole functional suite in the background, with port 5173 freed and any stale preview server killed. Expect 43 passed and 2 skipped or better, with no new failures. Check the e2e selectors in `apps/host/tests/e2e/{global-setup.ts,truapi.spec.ts,fixtures/paired.ts}` against the new markup by reading them; e2e cannot run locally.
- [ ] Sizes against the end of 4b (650a9df9, built in a temporary worktree):
  - host startup at most 96,831 B, and the running total under +25,600 B over the pre-migration 74,649 B;
  - sandbox unchanged (±50 B);
  - report the lazy islands chunk.

  Cold start, 20-run A/B: at most +5% on `Host total`.
- [ ] Record an "After sub-project 4c" section in `docs/perf/solid-migration-baseline.md`, and commit `docs(perf): record sub-project 4c sizes and cold start`.
