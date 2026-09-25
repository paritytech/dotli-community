# Solid v2 Migration — Sub-project 0 addendum: Solid-free stores

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take `@solidjs/signals` off the host and sandbox eager paths by making the stores plain values with listeners, and give components a `useStore` helper that turns a store into a Solid accessor.

**Architecture:** `createSyncStore` drops its Solid signal and gains `subscribe`. Each state module exports a `ReadableStore` (`authStore`, `productStore`, …) in place of its reactive accessor. `packages/ui/src/components/use-store.ts` (UI-only, not imported by apps yet) bridges a store to a Solid signal with cleanup. Getters, setters and every window event are unchanged.

**Tech Stack:** TypeScript 6, Vitest 5 + happy-dom, `solid-js` / `@solidjs/web` 2.0.0-rc.9, `@solidjs/testing-library` 1.0.0-beta.3.

**Spec:** `docs/superpowers/specs/2026-09-25-solid-v2-sp0-foundation-design.md` (section 2 "Module contract", amended 2026-09-25; parent `docs/superpowers/specs/2026-09-25-solid-v2-ui-migration-design.md`)

## Global Constraints

- Nothing under `packages/ui/src/state/` imports `solid-js` or any `@solidjs/*` package.
- No Solid package may reach a host or sandbox production chunk (neither `@solidjs/signals` nor `@solidjs/web`).
- Getters (`getAuthState`, …), setters (`setAuthState`, …) and every window event keep their names, `Event`/`CustomEvent` type, exact `detail` shape and dispatch order (store state and listeners first, event second).
- Store defaults never read `window`, `localStorage`, or `matchMedia`.
- Every new source file starts with `// Copyright 2026 Parity Technologies (UK) Ltd.` / `// SPDX-License-Identifier: AGPL-3.0-only`.
- Tests: `it("As a <role>, <behaviour>", …)` with `// Given`, `// When`, `// Then`.
- No empty `catch {}` blocks.
- Gates: host and sandbox eager paths (entry chunk plus every chunk it statically imports) each grow by less than 3 KB gzip versus the pre-migration baseline; no cold-start regression beyond 5%.

## Review Focus

1. **A subscriber that throws** — must not stop other subscribers, the setter, or the window event after it. Pinned in Task 1 (`create-store` test "a throwing listener is reported and the rest still run").
2. **A listener that unsubscribes itself (or another listener) during notification** — iteration must not skip or double-call. Pinned in Task 1 (`create-store` test "unsubscribing during notify").
3. **A component unmounting** — `useStore` must unsubscribe, or listeners leak across mounts. Pinned in Task 1 (`use-store` test).
4. **`resetAllStoresForTests` with a live subscriber** — reset notifies like any set, so a mounted component sees the default. Pinned in Task 1 (`create-store` reset test).
5. **Tree-shaking regression** — `use-store.ts` or `mount/root.ts` accidentally imported by app code would pull Solid back in. Pinned in Task 2 (sourcemap grep).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `packages/ui/src/state/create-store.ts` | Modify | plain store: value + listener set, no Solid |
| `packages/ui/src/state/{auth,product,permissions,chat,network,settings,theme,topbar}.ts` | Modify | export `xStore: ReadableStore<…>` in place of the reactive accessor |
| `packages/ui/src/components/use-store.ts` | Create | `useStore(store)` → Solid accessor with cleanup |
| `packages/ui/tests/state/create-store.test.ts` | Modify | subscription semantics |
| `packages/ui/tests/state/{auth,product,permissions,chat,theme,topbar}.test.ts` | Modify | assert through `xStore.get()` instead of the old accessor |
| `packages/ui/tests/components/use-store.test.tsx` | Create | component reactivity + unsubscribe on unmount |
| `docs/perf/solid-migration-baseline.md` | Modify | "After Solid-free stores" section |

Accessor → store export renames (every one is referenced only by its own state test today):

| Module | Old export | New export |
|---|---|---|
| `state/auth.ts` | `authState`, `loggedIn` | `authStore`, `loggedInStore` |
| `state/product.ts` | `productState` | `productStore` |
| `state/permissions.ts` | `permissionsState` | `permissionsStore` |
| `state/chat.ts` | `chatState` | `chatStore` |
| `state/network.ts` | `networkState` | `networkStore` |
| `state/settings.ts` | `settingsState` | `settingsStore` |
| `state/theme.ts` | `themeState` | `themeStore` |
| `state/topbar.ts` | `topbarState` | `topbarStore` |

---

### Task 1: Solid-free stores and `useStore`

**Files:**
- Modify: `packages/ui/src/state/create-store.ts`
- Modify: `packages/ui/src/state/auth.ts`, `product.ts`, `permissions.ts`, `chat.ts`, `network.ts`, `settings.ts`, `theme.ts`, `topbar.ts`
- Create: `packages/ui/src/components/use-store.ts`
- Modify: `packages/ui/tests/state/create-store.test.ts`, `auth.test.ts`, `product.test.ts`, `permissions.test.ts`, `chat.test.ts`, `theme.test.ts`, `topbar.test.ts`
- Create: `packages/ui/tests/components/use-store.test.tsx`

**Interfaces:**
- Consumes: `captureException(err: unknown, tags?: Record<string, string>): void` from `@dotli/metrics/sentry`; `renderComponent`, `settle`, `resetStores` from `packages/ui/tests/helpers/solid.ts`.
- Produces:
  ```ts
  // state/create-store.ts
  export interface ReadableStore<T> { get: () => T; subscribe: (listener: () => void) => () => void }
  export interface SyncStore<T> extends ReadableStore<T> { set: (next: T) => void; reset: () => void }
  export function createSyncStore<T>(initial: T): SyncStore<T>;
  export function resetAllStoresForTests(): void;
  // components/use-store.ts
  export function useStore<T>(store: ReadableStore<T>): Accessor<T>;
  // state modules: the store exports in the rename table above, typed ReadableStore<…>
  ```

- [ ] **Step 1: Rewrite the `create-store` test (fails: no `subscribe`)**

Replace `packages/ui/tests/state/create-store.test.ts` with:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

import {
  createSyncStore,
  resetAllStoresForTests,
} from "@dotli/ui/state/create-store";

describe("createSyncStore", () => {
  beforeEach(() => {
    sentry.captureException.mockClear();
  });

  it("As non-UI code, the getter returns the value just set", () => {
    // Given
    const store = createSyncStore<{ n: number }>({ n: 0 });

    // When
    store.set({ n: 1 });

    // Then
    expect(store.get()).toEqual({ n: 1 });
  });

  it("As a subscriber, I am notified synchronously after each set, and the getter is already current", () => {
    // Given
    const store = createSyncStore(0);
    const seen: number[] = [];
    store.subscribe(() => {
      seen.push(store.get());
    });

    // When
    store.set(1);
    store.set(2);

    // Then
    expect(seen).toEqual([1, 2]);
  });

  it("As a subscriber, after unsubscribing I am no longer notified", () => {
    // Given
    const store = createSyncStore("a");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    // When
    unsubscribe();
    store.set("b");

    // Then
    expect(listener).not.toHaveBeenCalled();
  });

  it("As a subscriber, unsubscribing during notify neither skips nor repeats other listeners", () => {
    // Given
    const store = createSyncStore(0);
    const calls: string[] = [];
    const unsubscribeFirst = store.subscribe(() => {
      calls.push("first");
      unsubscribeFirst();
    });
    store.subscribe(() => {
      calls.push("second");
    });

    // When
    store.set(1);
    store.set(2);

    // Then
    expect(calls).toEqual(["first", "second", "second"]);
  });

  it("As a setter, a throwing listener is reported and the rest still run", () => {
    // Given
    const store = createSyncStore(0);
    const after = vi.fn();
    store.subscribe(() => {
      throw new Error("listener boom");
    });
    store.subscribe(after);

    // When
    store.set(1);

    // Then
    expect(store.get()).toBe(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listener boom" }),
      { kind: "store_listener_error" },
    );
  });

  it("As a test author, resetAllStoresForTests restores every store and notifies its subscribers", () => {
    // Given
    const a = createSyncStore("a");
    const b = createSyncStore<string[]>([]);
    const onA = vi.fn();
    a.subscribe(onA);
    a.set("changed");
    b.set(["x"]);
    onA.mockClear();

    // When
    resetAllStoresForTests();

    // Then
    expect(a.get()).toBe("a");
    expect(b.get()).toEqual([]);
    expect(onA).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/ui vitest run tests/state/create-store.test.ts`
Expected: FAIL — `store.subscribe is not a function` (and the throwing-listener test fails).

- [ ] **Step 3: Rewrite `create-store.ts` without Solid**

Replace `packages/ui/src/state/create-store.ts` with:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A value plus the listeners that want to hear when it changes. Deliberately
 * free of Solid: stores are imported by boot-path code (bridge, topbar, host
 * callbacks, the sandbox's error screen), and Solid's reactive core would
 * otherwise ship on those eager paths before any component reads a store.
 * Components bridge a store to a signal with `useStore` from
 * `components/use-store.ts`.
 */

import { captureException } from "@dotli/metrics/sentry";

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

const registry = new Set<() => void>();

export function createSyncStore<T>(initial: T): SyncStore<T> {
  let current = initial;
  const listeners = new Set<() => void>();

  const set = (next: T): void => {
    current = next;
    // Snapshot so a listener that unsubscribes (itself or another) during
    // notification neither skips nor repeats anyone in this round.
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        // A broken UI listener must not stop the producer's event dispatch.
        captureException(err, { kind: "store_listener_error" });
      }
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const reset = (): void => {
    set(initial);
  };
  registry.add(reset);

  return { get: () => current, set, subscribe, reset };
}

/** Restore every store created so far to its initial value. Tests only. */
export function resetAllStoresForTests(): void {
  for (const reset of registry) {
    reset();
  }
}
```

If lint's `no-restricted-syntax` rule requires a `log.error` alongside `captureException` in catch blocks (check the rule's message in `packages/eslint-config/vite.js`), add the call it asks for using the repo's logger (`import { log } from "@dotli/shared/log"`), e.g. `log.error("[store] listener threw", err);`.

- [ ] **Step 4: Run the `create-store` test**

Run: `bun run --cwd packages/ui vitest run tests/state/create-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Replace each module's reactive accessor with its store export**

In each state module, delete the accessor line and export the readable store, typed as `ReadableStore<…>` so callers cannot reach `set`/`reset`. Add `type ReadableStore` to the existing `./create-store` import. Keep the getter and setter exports exactly as they are.

`state/auth.ts`:
```ts
import { createSyncStore, type ReadableStore } from "./create-store";
// …
export const authStore: ReadableStore<DotliAuthState> = auth;
export const getAuthState = auth.get;
// …
export const loggedInStore: ReadableStore<boolean> = session;
export const getLoggedIn = session.get;
```

The same pattern for the others:
```ts
export const productStore: ReadableStore<ProductState> = product;           // state/product.ts
export const permissionsStore: ReadableStore<PermissionsState> = permissions; // state/permissions.ts
export const chatStore: ReadableStore<ChatState> = chat;                    // state/chat.ts
export const networkStore: ReadableStore<NetworkState> = network;           // state/network.ts
export const settingsStore: ReadableStore<SettingsState | null> = settings; // state/settings.ts
export const themeStore: ReadableStore<ThemeState> = theme;                 // state/theme.ts
export const topbarStore: ReadableStore<TopbarState> = topbar;              // state/topbar.ts
```

Then confirm no Solid import is left under `state/` and nothing still references `.read` or an old accessor:

```bash
grep -rn "solid" packages/ui/src/state/ || echo "state: solid-free"
grep -rnE "\b(authState|loggedIn|productState|permissionsState|chatState|networkState|settingsState|themeState|topbarState)\b" packages/ui/src/state packages/ui/tests/state
```

The first prints `state: solid-free`. The second should only show the test lines you update in the next step (`chat/panel.ts` has an unrelated local `loggedIn` variable; ignore it).

- [ ] **Step 6: Update the store tests to read through the store**

In each of `auth.test.ts`, `product.test.ts`, `permissions.test.ts`, `chat.test.ts`, `theme.test.ts`, `topbar.test.ts` under `packages/ui/tests/state/`:
- change the import of the old accessor to the new store export (e.g. `authState` → `authStore`, `loggedIn` → `loggedInStore`);
- replace each old accessor call `xState()` with `xStore.get()` (e.g. `expect(authState()).toEqual(…)` → `expect(authStore.get()).toEqual(…)`, `expect(topbarState().visible)` → `expect(topbarStore.get().visible)`);
- drop `settle` from a test and its import only if nothing else in that file still uses it.

Add one test to `auth.test.ts` pinning notification order against the event (Review Focus: store state and listeners first, event second):

```ts
  it("As a component, my store listener runs before dotli:truapi-auth-state is dispatched", () => {
    // Given
    const order: string[] = [];
    const unsubscribe = authStore.subscribe(() => order.push("listener"));
    const onEvent = (): void => {
      order.push("event");
    };
    window.addEventListener("dotli:truapi-auth-state", onEvent);

    // When
    setAuthState({ tag: "Authenticating" });

    // Then
    expect(order).toEqual(["listener", "event"]);
    unsubscribe();
    window.removeEventListener("dotli:truapi-auth-state", onEvent);
  });
```

Run: `bun run --cwd packages/ui vitest run tests/state`
Expected: PASS.

- [ ] **Step 7: Write the `useStore` test (fails: module missing)**

Create `packages/ui/tests/components/use-store.test.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { JSX } from "@solidjs/web";
import {
  createSyncStore,
  type ReadableStore,
} from "@dotli/ui/state/create-store";
import { useStore } from "@dotli/ui/components/use-store";
import { renderComponent, settle } from "../helpers/solid";

function Label(props: { store: ReadableStore<string> }): JSX.Element {
  const value = useStore(props.store);
  return <span class="label">{value()}</span>;
}

describe("useStore", () => {
  it("As a component, I render the store's value and re-render after it changes", async () => {
    // Given
    const store = createSyncStore("first");
    const view = renderComponent(() => <Label store={store} />);
    expect(view.container.querySelector(".label")?.textContent).toBe("first");

    // When
    store.set("second");
    await settle();

    // Then
    expect(view.container.querySelector(".label")?.textContent).toBe("second");
  });

  it("As a component, unmounting unsubscribes me from the store", async () => {
    // Given
    const store = createSyncStore("x");
    let active = 0;
    const counted: ReadableStore<string> = {
      get: store.get,
      subscribe: (listener) => {
        active += 1;
        const off = store.subscribe(listener);
        return () => {
          active -= 1;
          off();
        };
      },
    };
    const view = renderComponent(() => <Label store={counted} />);
    await settle();
    expect(active).toBe(1);

    // When
    view.unmount();

    // Then
    expect(active).toBe(0);
  });
});
```

Run: `bun run --cwd packages/ui vitest run tests/components/use-store.test.tsx`
Expected: FAIL — cannot resolve `@dotli/ui/components/use-store`.

- [ ] **Step 8: Implement `useStore`**

Create `packages/ui/src/components/use-store.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { ReadableStore } from "../state/create-store";

/**
 * Read a store from a component. Returns a Solid accessor that follows the
 * store and unsubscribes when the owning component is disposed. Call it inside
 * a component or another reactive owner.
 */
export function useStore<T>(store: ReadableStore<T>): Accessor<T> {
  // Value form, not a compute function: in Solid 2 a function first argument
  // makes a derived signal. Stores never hold functions.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors createSignal's own overload
  const [value, setValue] = createSignal<T>(store.get() as Exclude<T, Function>);
  const unsubscribe = store.subscribe(() => {
    // Wrapped so a function-valued T would be stored, not called as an updater.
    const next = store.get();
    setValue(() => next);
  });
  onCleanup(unsubscribe);
  return value;
}
```

If `onCleanup` is not exported from `solid-js` rc.9 under that name, use the cleanup export the package provides (check `node_modules/solid-js/types/index.d.ts`; `onCleanup` is in its re-export list from `@solidjs/signals`).

- [ ] **Step 9: Run the component test and the full package checks**

```bash
bun run --cwd packages/ui vitest run tests/components/use-store.test.tsx
bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test
bun run --cwd apps/host test && bun run --cwd apps/sandbox test
```

Expected: all PASS; existing suites (topbar, chat-panel, bridge, permission-modal, …) unchanged and green.

- [ ] **Step 10: Commit**

```bash
git add packages/ui/src/state packages/ui/src/components/use-store.ts \
  packages/ui/tests/state packages/ui/tests/components/use-store.test.tsx
git commit -m "refactor(ui): make stores Solid-free and add useStore for components"
```

---

### Task 2: Measure and record the effect

**Files:**
- Modify: `docs/perf/solid-migration-baseline.md`

**Interfaces:**
- Consumes: Task 1's commit. Produces: the final size record for sub-project 0.

- [ ] **Step 1: Production build**

```bash
VITE_NETWORKS=paseo-next-v2,previewnet bun run build
```

Expected: succeeds.

- [ ] **Step 2: No Solid in any app chunk (Review Focus 5)**

```bash
grep -l '@solidjs/signals\|@solidjs/web\|solid-js' apps/host/dist/assets/*.js.map apps/sandbox/dist/assets/*.js.map || echo "solid: absent from app bundles"
grep -l 'use-store\|SolidProbe\|mount/root' apps/host/dist/assets/*.js.map apps/sandbox/dist/assets/*.js.map || echo "ui-only modules: absent"
```

Expected: `solid: absent from app bundles` and `ui-only modules: absent`. Anything else is a failure: report which map and which source pulled it in.

- [ ] **Step 3: Measure sizes the same way as before**

```bash
for f in apps/host/dist/assets/*.js apps/sandbox/dist/assets/*.js; do
  printf '%s\t%d\t%d\n' "$f" "$(wc -c <"$f")" "$(gzip -c "$f" | wc -c)"
done | sort
```

Compute each eager path: the entry `index-*.js` plus every chunk it imports statically (read the `import` statements at the top of the built `index-*.js`, or the `<link rel="modulepreload">` tags in `dist/index.html`). Compare with the pre-migration baseline rows for the same set.

- [ ] **Step 4: Append the section**

Append to `docs/perf/solid-migration-baseline.md`:

````markdown
## After Solid-free stores (sub-project 0 addendum)

Stores no longer import Solid; components will use `useStore` (not yet
imported by app code). Measured with the same build command and method.

| Eager path | Before migration gzip | Now gzip | Δ gzip | Gate (< 3 KB) |
|---|---|---|---|---|
| host (index + static imports) | <before> | <now> | <delta> | <pass/fail> |
| sandbox (index + static imports) | <before> | <now> | <delta> | <pass/fail> |

Solid packages in app sourcemaps: <absent/present + detail>.
````

Fill every `<…>`. Also update the earlier gate lines' verdict text if they say "decision pending with the owner": append "— resolved by the Solid-free stores addendum below".

- [ ] **Step 5: Cold start (optional if the environment allows)**

```bash
bun run --cwd apps/host test:perf && bun run --cwd apps/host test:perf:compare
```

If it runs, add the Host total median and Δ% to the section with the verdict against "no regression beyond 5%". If it can't run here, write "not re-measured" and why.

- [ ] **Step 6: Commit**

```bash
git add docs/perf/solid-migration-baseline.md
git commit -m "docs(perf): record eager sizes after Solid-free stores"
```
