# Solid.js v2 migration — sub-project 0: Foundation

Status: approved in brainstorming, 2026-09-25. Parent design:
`2026-09-25-solid-v2-ui-migration-design.md`.

## Goal

Make Solid 2 usable everywhere the UI will need it, and put the state stores in
place, with **no user-visible change**. After this sub-project, sub-projects 1
and 2 can start writing components immediately.

## Scope

In:

1. Pinned dependencies and JSX tooling (TypeScript, Vite, Vitest, ESLint).
2. Signal stores in `packages/ui/src/state/`, fed by the current producers.
3. Mount and test helpers.
4. One trivial component that proves the toolchain end to end.
5. Bundle-size and cold-start baselines.
6. Deleting the unused `packages/ui/src/alias-permission-modal.ts`.

Out: migrating any existing UI, removing any window event, the prerender
plugin (sub-project 4), `apps/protocol`.

## 1. Dependencies and tooling

### Dependencies (exact versions, no `^`)

| Package | Version | Where |
|---|---|---|
| `solid-js` | `2.0.0-rc.9` | `packages/ui`, `packages/truapi-debug`, `packages/sandbox-checker` (dependencies) |
| `@solidjs/web` | `2.0.0-rc.9` | same |
| `@solidjs/signals` | `2.0.0-rc.9` | pinned via root `overrides` so every copy is the one `solid-js` expects |
| `@solidjs/vite-plugin` | `3.0.0-next.44` | `apps/host`, `apps/sandbox`, `packages/ui` (devDependencies; `packages/ui` for Vitest) |
| `@solidjs/testing-library` | `1.0.0-beta.3` | `packages/ui`, `apps/host`, `apps/sandbox` (devDependencies) |

`bun.lock` is committed. The versions are listed in one place,
`docs/perf/solid-migration-baseline.md`, for the bump checklist.

### TypeScript

- New `packages/typescript-config/solid.json`:
  ```json
  { "compilerOptions": { "jsx": "preserve", "jsxImportSource": "@solidjs/web" } }
  ```
- `packages/ui`, `packages/truapi-debug`, `packages/sandbox-checker`,
  `apps/host`, and `apps/sandbox` tsconfigs add it to `extends`.
- `include` already covers `src`; `.tsx` files under `src` are picked up.

### Vite

- `apps/host/vite.config.ts`: `solid({ ssr: true })` placed before `wasm()`.
- `apps/sandbox/vite.config.ts`: `solid()` in the main build only, not in the
  nested service-worker `viteBuild`.
- `apps/protocol`: unchanged.

### Vitest

- Add the Solid plugin to `packages/ui/vitest.config.ts`,
  `apps/host/vitest.config.ts`, and `apps/sandbox/vitest.config.ts`.
- Widen `include` to `*.test.{ts,tsx}` in each.
- Environment stays `happy-dom`.

### ESLint

- `packages/eslint-config/vite.js` gets a block for `**/*.tsx`:
  - `eslint-plugin-solid` recommended rules, **only if** its current release
    parses Solid 2 JSX without false positives on the proof component. If it
    does not, the block is added without the plugin and a comment names the
    blocker.
  - `@typescript-eslint/explicit-function-return-type` off for `.tsx`
    (components return `JSX.Element` by inference).
- Prettier already covers `*.tsx`; no change.

## 2. State stores

### Module contract

Amended 2026-09-25: stores are Solid-free. The first implementation backed each
store with a Solid signal, which put `@solidjs/signals` on the host and sandbox
eager paths (+9.8 KB / +9.5 KB gzip) before any component used it. The owner
chose to keep Solid out of the stores until a component needs it.

`packages/ui/src/state/create-store.ts` (no `solid-js` import):

```ts
export interface ReadableStore<T> {
  /** Latest written value, immediately. */
  get: () => T;
  /** Called synchronously after every set. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

export interface SyncStore<T> extends ReadableStore<T> {
  /** The only writer: updates the value, then notifies listeners in order. */
  set: (next: T) => void;
  /** Restore the initial value. Tests only. */
  reset: () => void;
}

export function createSyncStore<T>(initial: T): SyncStore<T>;
export function resetAllStoresForTests(): void;
```

A listener that throws is reported through `captureException` and does not stop
the other listeners, the setter, or the event dispatch that follows.
Notifications are synchronous. Listeners must not call store setters: a
nested set notifies and dispatches its window event before the outer one
does.

Each store module exports its readable store, a getter, and setters:

```ts
// state/auth.ts
const auth = createSyncStore<DotliAuthState>({ tag: "Disconnected" });
export const authStore: ReadableStore<DotliAuthState> = auth;
export const getAuthState = auth.get;
export function setAuthState(next: DotliAuthState): void {
  auth.set(next);               // state and listeners first
  window.dispatchEvent(…);      // then the unchanged event
}
```

Components read a store through `packages/ui/src/components/use-store.ts`:

```ts
export function useStore<T>(store: ReadableStore<T>): Accessor<T>;
```

It creates a Solid signal seeded with `store.get()`, subscribes, writes the
signal on each notification, and unsubscribes with `onCleanup`. It must be
called inside a component or another reactive owner: `useStore` throws
outside an owner rather than leaking a subscription. Its mirror signal is
created with `{ ownedWrite: true }` so a store set dispatched from an owner
other than the signal's own (e.g. a `createRoot` scope) still reaches the
accessor instead of Solid 2's dev build throwing
`REACTIVE_WRITE_IN_OWNED_SCOPE`.

Rules:

- Nothing under `packages/ui/src/state/` imports `solid-js`. Non-UI code uses
  getters and setters only.
- The default value is fixed and does not read `window`, `localStorage`, or
  `matchMedia`. That keeps the stores safe for build-time rendering in
  sub-project 4.
- Setters keep dispatching the same window event with the same `detail` as the
  current producer does, so every existing listener keeps working unchanged.

### Stores and their producers in this sub-project

| Store | State | Fed by | Events the setter dispatches |
|---|---|---|---|
| `auth` | `DotliAuthState` (moved from `host-callbacks/AuthState.ts`), `loggedIn: boolean` | `dispatchAuthState` in `AuthState.ts` calls `setAuthState`; `topbar.ts:525` / `:543` call `setLoggedIn` | `dotli:truapi-auth-state`, `dotli:logged-out`, `dotli:authenticated` |
| `product` | `{ status: "none" } \| { status: "loaded", label, productId } \| { status: "error" }` | `bridge.ts:1068`, `:1244`; `ui.ts:782`, `:833` | `dotli:product-loaded`, `dotli:product-error` |
| `permissions` | change counter `version` plus the last change `{ kind: "grant" \| "device", label, permission? }` (statuses stay in `permissions.ts`; components re-read them when `version` changes) | `host-callbacks/PromptPermission.ts:168`, `:177` | `dotli:device-permission-changed`, `dotli:permission-changed` |
| `chat` | availability `{ label, chat }`, rooms / bots / message change counters | `chat/service.ts:77` (setter replaces the dispatch helper); availability via a listener on `CHAT_AVAILABILITY_EVENT` (producer lives in `packages/shared`, which must not import `packages/ui`) | `dotli:chat-*` (unchanged names and details) |
| `network` | mirror of `getNetworkStatus()` and `getTransfer()` | `startNetworkStore()` subscribes to `subscribeNetwork` and returns the unsubscribe; not called by production code until sub-project 4 | none |
| `settings` | `{ backend, cache, network, enabledNetworks }` | `initSettingsStore()` reads the `config/mode` and `config/network` getters once; called from host `main.ts` boot | none |
| `theme` | `{ pref: "light" \| "dark" \| "system", resolved: "light" \| "dark" }` | `applyThemePref` in `topbar.ts` calls `setTheme` (it already runs on the `matchMedia` change) | `dotli:theme-changed` |
| `topbar` | `{ visible: boolean, blockingModalActive: boolean, chainsButtonVisible: boolean }` | `topbar-autohide.ts:130`, `blocking-modal-queue.ts:168`, `setChainsButtonVisible` in `topbar.ts` | `topbar:visibility`, `dotli:blocking-modal-active` |

Command events (`dotli:request-login`, `dotli:truapi-login-request`,
`dotli:truapi-cancel-login`, `dotli:truapi-disconnect-request`) are not state
and are not touched.

`SessionStore.ts`'s `LOCAL_CHANGE_EVENT` stays as is; session data is owned by
the TrUAPI host.

## 3. Mount and test helpers

- `packages/ui/src/mount/root.ts`
  ```ts
  export function mountRoot(
    name: string,
    container: HTMLElement,
    view: () => JSX.Element,
  ): () => void;
  ```
  Wraps `render` from `@solidjs/web` in `<Errored>` whose fallback renders
  nothing visible and reports to Sentry through `@dotli/metrics` with the root
  `name` as a tag. Returns the disposer and keeps it in a registry
  (`disposeRoot(name)`), which sub-project 3 uses from `activateHost`.
- `packages/ui/src/mount/overlay-root.ts`
  `ensureOverlayRoot(): HTMLElement` creates `<div id="overlay-root">` as the
  last child of `body` on first call and returns it. Not called by production
  code in this sub-project; sub-project 1 wires it at boot.
- `packages/ui/tests/helpers/solid.ts`
  - `renderComponent(view)`: `@solidjs/testing-library` `render` plus cleanup.
  - `settle()`: `flush()` from `solid-js`, then `await Promise.resolve()`.
  - `resetStores()`: calls every `reset*ForTests`.

## 4. Proof component

`packages/ui/src/components/dev/SolidProbe.tsx`: a counter button (`class`,
`onClick`, a signal, `<Show>`). It is **not** imported by any app code, so it
never reaches a production bundle. Its test renders it, clicks, calls
`settle()`, and asserts the text. It exists to prove the TypeScript, Vite
plugin, Vitest, and ESLint setup, and is deleted in sub-project 1 once real
components exist.

The host and sandbox builds prove the Vite side: `bun run build` must succeed
with the plugin enabled. No Solid package may reach a host or sandbox chunk
(neither `@solidjs/signals` nor `@solidjs/web`), since the stores are Solid-free
and no app code renders a component yet. The plan checks this by grepping the
built chunks' sourcemaps, and the size delta is recorded against the baseline
(section 5).

## 5. Baselines

Recorded on `main` **before** the first commit of this sub-project and written
to `docs/perf/solid-migration-baseline.md`:

- Host and sandbox `dist/assets/*.js` raw and gzip sizes per chunk (same
  method as `.github/workflows/bundle-size.yml`).
- `bun run --cwd apps/host test:perf:base` results: median of
  `dotli:main:start` → `dotli:main:end` over 20 runs, plus the other marks the
  cold-start spec records.
- Exact Solid package versions (the bump checklist).

After the sub-project, the same measurements are repeated and appended. The
gate for this sub-project: the host and sandbox eager paths (the entry chunk
plus every chunk it statically imports) each grow by less than 3 KB gzip;
cold-start median shows no regression beyond 5%.

## 6. Dead code

Delete `packages/ui/src/alias-permission-modal.ts` and any test or style that
only it uses (verified by grep for `alias-permission-modal`,
`showAliasPermissionModal`, and its CSS classes).

## Testing

- One test file per store in `packages/ui/tests/state/`:
  - default value;
  - setter updates the sync getter immediately and notifies subscribers;
  - each still-required event is dispatched with the same `detail` shape as
    before.
- Existing test suites pass unchanged. In particular `topbar.test.ts`,
  `chat-panel.test.ts`, `bridge.test.ts`, `topbar-autohide.test.ts`, and
  `permission-modal.test.ts`, which listen to the events now dispatched from
  setters.
- `useStore` test: a component reading a store re-renders after `set` and
  `settle()`, and unmounting unsubscribes.
- `mountRoot` test: renders into a container, disposer empties it, a throwing
  view triggers the Sentry report and leaves sibling roots intact.
- Proof component test (section 4).
- `bun run build`, `bun run test`, `bun run lint`, `bun run typecheck`, and the
  host functional Playwright suite (`test:functional`) all green.

## Done when

- All checks in Testing pass.
- No user-visible change: the functional suite passes unchanged, and a manual
  `bun preview` check shows the landing page, a `.dot` load, login modal, and a
  toast behaving as before.
- `docs/perf/solid-migration-baseline.md` has before and after numbers within
  the gate.
- `alias-permission-modal.ts` is gone.
