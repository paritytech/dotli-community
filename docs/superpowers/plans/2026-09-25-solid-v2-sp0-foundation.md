# Solid v2 Migration — Sub-project 0: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Solid 2 compile, lint, and test in the dotli monorepo and put typed signal stores in place, fed by today's event producers, with no user-visible change.

**Architecture:** Pinned Solid 2 RC packages are added to the UI packages; a shared `solid.json` tsconfig preset and the `@solidjs/vite-plugin` enable `.tsx`. A tiny generic `createSyncStore` backs eight store modules in `packages/ui/src/state/`; each existing `window.dispatchEvent` producer calls a store setter instead, and the setter re-dispatches the identical event so every current listener keeps working. `mountRoot` and `ensureOverlayRoot` are added for later sub-projects but not wired into production code.

**Tech Stack:** Bun 1.3 workspaces, Turborepo, TypeScript 6, Vite 8, Vitest 5 + happy-dom, `solid-js` / `@solidjs/web` / `@solidjs/signals` 2.0.0-rc.9, `@solidjs/vite-plugin` 3.0.0-next.44, `@solidjs/testing-library` 1.0.0-beta.3.

**Spec:** `docs/superpowers/specs/2026-09-25-solid-v2-sp0-foundation-design.md` (parent: `docs/superpowers/specs/2026-09-25-solid-v2-ui-migration-design.md`)

## Global Constraints

- Solid versions are exact, no `^`: `solid-js` `2.0.0-rc.9`, `@solidjs/web` `2.0.0-rc.9`, `@solidjs/signals` `2.0.0-rc.9`, `@solidjs/vite-plugin` `3.0.0-next.44`, `@solidjs/testing-library` `1.0.0-beta.3`.
- `jsxImportSource` is `"@solidjs/web"` (Solid 2 ships the JSX runtime there), `jsx` is `"preserve"`.
- No user-visible change. No window event is removed or renamed; every event keeps its exact `detail` shape.
- Non-UI code never imports `solid-js`; it uses store getters and setters only.
- Store defaults never read `window`, `localStorage`, or `matchMedia`.
- `apps/protocol` is not touched.
- Every new source file starts with the repo licence header:
  ```ts
  // Copyright 2026 Parity Technologies (UK) Ltd.
  // SPDX-License-Identifier: AGPL-3.0-only
  ```
- Tests follow the repo style: `it("As a <role>, <behaviour>", …)` with `// Given`, `// When`, `// Then` comments.
- Empty `catch {}` blocks are forbidden by lint (`no-restricted-syntax`); don't add any.
- Gates: host eager `index-*.js` grows < 3 KB gzip; cold-start `dotli:main:start` → `dotli:main:end` median within 5% of baseline.

## Review Focus

1. **Write-then-read in the same tick from non-UI code** — `getX()` must return the value just set, before any flush. Pinned in Task 3 (`createSyncStore` test "sync getter is immediate").
2. **Event listeners that run synchronously inside `dispatchEvent` and read the store** — the store must already hold the new value when the event fires (set state first, dispatch second). Pinned in Task 4 (auth listener test).
3. **Tests that call `vi.resetModules()` and re-import modules** (most of `packages/ui/tests`) — a fresh store instance per module graph must not leak state or break existing suites. Pinned in Task 4 Step 6 and Task 12 (full suite run unchanged).
4. **A root whose view throws on mount** — must report to Sentry and leave sibling roots and the page intact, not blank the page. Pinned in Task 10 (`mountRoot` throwing-view test).
5. **Production bundle accidentally pulling in `@solidjs/web` or the dev probe component** — the probe must never ship. Pinned in Task 12 Step 3 (grep of built chunks).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | root `overrides` pin for `@solidjs/signals` |
| `packages/typescript-config/solid.json` | Create | JSX compiler options preset |
| `packages/ui/package.json`, `packages/truapi-debug/package.json`, `packages/sandbox-checker/package.json`, `apps/host/package.json`, `apps/sandbox/package.json` | Modify | Solid deps |
| `packages/ui/tsconfig.json`, `packages/truapi-debug/tsconfig.json`, `packages/sandbox-checker/tsconfig.json`, `apps/host/tsconfig.json`, `apps/sandbox/tsconfig.json` | Modify | extend `solid.json` |
| `apps/host/vite.config.ts`, `apps/sandbox/vite.config.ts` | Modify | Solid plugin |
| `packages/ui/vitest.config.ts`, `apps/host/vitest.config.ts`, `apps/sandbox/vitest.config.ts` | Modify | Solid plugin, `.tsx` tests |
| `packages/eslint-config/vite.js`, `packages/eslint-config/package.json` | Modify | `.tsx` rules |
| `packages/ui/src/components/dev/SolidProbe.tsx` | Create | toolchain proof (deleted in sub-project 1) |
| `packages/ui/src/state/create-store.ts` | Create | generic sync + reactive store |
| `packages/ui/src/state/{auth,product,permissions,chat,network,settings,theme,topbar}.ts` | Create | one store per area |
| `packages/ui/src/host-callbacks/AuthState.ts` | Modify | `dispatchAuthState` → `setAuthState` |
| `packages/ui/src/topbar.ts` | Modify | logged-in/out, theme, chains-button producers |
| `packages/ui/src/bridge.ts`, `packages/ui/src/ui.ts` | Modify | product producers |
| `packages/ui/src/host-callbacks/PromptPermission.ts` | Modify | permission producers |
| `packages/ui/src/chat/service.ts` | Modify | chat producers |
| `packages/ui/src/topbar-autohide.ts`, `packages/ui/src/blocking-modal-queue.ts` | Modify | topbar producers |
| `apps/host/src/main.ts` | Modify | call `initSettingsStore()` and `initChatStore()` at boot |
| `packages/ui/src/mount/root.ts`, `packages/ui/src/mount/overlay-root.ts` | Create | mount helpers |
| `packages/ui/tests/helpers/solid.ts` | Create | `settle`, `renderComponent` |
| `packages/ui/tests/state/*.test.ts`, `packages/ui/tests/mount/*.test.tsx`, `packages/ui/tests/components/solid-probe.test.tsx` | Create | tests |
| `packages/ui/src/alias-permission-modal.ts` | Delete | dead code |
| `docs/perf/solid-migration-baseline.md` | Create | baseline and after numbers, version list |

---

### Task 1: Record the baseline on `main`

**Files:**
- Create: `docs/perf/solid-migration-baseline.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the baseline document Task 12 appends to.

- [ ] **Step 1: Create a worktree branch from `main`**

The spec docs live on `docs/solid-v2-migration-spec`. Branch from it so the plan and specs travel with the code:

```bash
git checkout docs/solid-v2-migration-spec
git checkout -b feat/solid-v2-foundation
```

- [ ] **Step 2: Build production bundles with no Solid changes**

```bash
bun install --frozen-lockfile
VITE_NETWORKS=paseo-next-v2,previewnet bun run build
```

Expected: build succeeds; `apps/host/dist/assets` and `apps/sandbox/dist/assets` exist.

- [ ] **Step 3: Measure chunk sizes (same method as `.github/workflows/bundle-size.yml`)**

```bash
for f in apps/host/dist/assets/*.js apps/sandbox/dist/assets/*.js; do
  printf '%s\t%d\t%d\n' "$f" "$(wc -c <"$f")" "$(gzip -c "$f" | wc -c)"
done | sort > /tmp/solid-baseline-sizes.tsv
cat /tmp/solid-baseline-sizes.tsv
```

- [ ] **Step 4: Run the cold-start baseline**

```bash
bun run --cwd apps/host test:perf:base
```

Expected: completes and writes its baseline JSON (path printed by the spec). Note the median of `dotli:main:start` → `dotli:main:end`. If the perf suite needs network access and fails in this environment, record "not measured locally" and the failure line; Task 12 then uses the CI `perf.yml` comparison instead.

- [ ] **Step 5: Write the baseline doc**

Create `docs/perf/solid-migration-baseline.md`:

````markdown
# Solid v2 migration — size and cold-start baseline

Measured on the commit before sub-project 0 (`git rev-parse HEAD` → `<sha>`).

## Solid package versions (bump checklist)

| Package | Version |
|---|---|
| solid-js | 2.0.0-rc.9 |
| @solidjs/web | 2.0.0-rc.9 |
| @solidjs/signals | 2.0.0-rc.9 |
| @solidjs/vite-plugin | 3.0.0-next.44 |
| @solidjs/testing-library | 1.0.0-beta.3 |

On a bump: update all rows together, run `bunx solid-migration-assistant`, read the
RC changelog, re-run the measurements below.

## Before sub-project 0

### Chunk sizes (bytes)

| Chunk | Raw | Gzip |
|---|---|---|
<one row per line of /tmp/solid-baseline-sizes.tsv; strip the content hash from the name, e.g. `host index-*.js`>

### Cold start (`test:perf:base`, 20 runs)

| Mark pair | Median ms |
|---|---|
| dotli:main:start → dotli:main:end | <value> |
````

Fill every `<…>` with the measured values before committing.

- [ ] **Step 6: Commit**

```bash
git add docs/perf/solid-migration-baseline.md
git commit -m "docs(perf): record bundle and cold-start baseline before Solid migration"
```

---

### Task 2: Solid toolchain (deps, TypeScript, Vite, Vitest, ESLint) proven by a probe component

**Files:**
- Modify: `package.json` (root), `packages/ui/package.json`, `packages/truapi-debug/package.json`, `packages/sandbox-checker/package.json`, `apps/host/package.json`, `apps/sandbox/package.json`, `bun.lock`
- Create: `packages/typescript-config/solid.json`
- Modify: `packages/ui/tsconfig.json`, `packages/truapi-debug/tsconfig.json`, `packages/sandbox-checker/tsconfig.json`, `apps/host/tsconfig.json`, `apps/sandbox/tsconfig.json`
- Modify: `apps/host/vite.config.ts`, `apps/sandbox/vite.config.ts`
- Modify: `packages/ui/vitest.config.ts`, `apps/host/vitest.config.ts`, `apps/sandbox/vitest.config.ts`
- Modify: `packages/eslint-config/vite.js`, `packages/eslint-config/package.json`
- Create: `packages/ui/src/components/dev/SolidProbe.tsx`
- Create: `packages/ui/tests/helpers/solid.ts`
- Test: `packages/ui/tests/components/solid-probe.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `settle(): Promise<void>` and `renderComponent(view: () => JSX.Element): RenderResult` from `packages/ui/tests/helpers/solid.ts` (import path in tests: `../helpers/solid` or `../../tests/helpers/solid` relative to the test file).
  - `.tsx` compiles in `packages/ui`, `packages/truapi-debug`, `packages/sandbox-checker`, `apps/host`, `apps/sandbox`.

- [ ] **Step 1: Add dependencies**

```bash
bun add --exact --cwd packages/ui solid-js@2.0.0-rc.9 @solidjs/web@2.0.0-rc.9
bun add --exact --cwd packages/ui -d @solidjs/vite-plugin@3.0.0-next.44 @solidjs/testing-library@1.0.0-beta.3
bun add --exact --cwd packages/truapi-debug solid-js@2.0.0-rc.9 @solidjs/web@2.0.0-rc.9
bun add --exact --cwd packages/sandbox-checker solid-js@2.0.0-rc.9 @solidjs/web@2.0.0-rc.9
bun add --exact --cwd apps/host -d @solidjs/vite-plugin@3.0.0-next.44 @solidjs/testing-library@1.0.0-beta.3
bun add --exact --cwd apps/sandbox -d @solidjs/vite-plugin@3.0.0-next.44 @solidjs/testing-library@1.0.0-beta.3
```

Then add `"@solidjs/signals": "2.0.0-rc.9"` to the root `package.json` `overrides` object (keep existing entries, alphabetical position is not required there). Run `bun install` and confirm a single copy:

```bash
bun install
find . -path '*/node_modules/@solidjs/signals/package.json' -not -path './node_modules/.cache/*' -exec jq -r .version {} \; | sort -u
```

Expected: exactly one line, `2.0.0-rc.9`. Check that no `^` crept in: `grep -n '"solid-js"\|"@solidjs/' apps/*/package.json packages/*/package.json` shows only exact versions.

- [ ] **Step 2: Add the tsconfig preset and extend it**

Create `packages/typescript-config/solid.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "@solidjs/web"
  }
}
```

In each of `packages/ui/tsconfig.json`, `packages/truapi-debug/tsconfig.json`, `packages/sandbox-checker/tsconfig.json`, `apps/host/tsconfig.json`, `apps/sandbox/tsconfig.json`, append `"@dotli/typescript-config/solid.json"` to the `extends` array. Example for `packages/ui/tsconfig.json`:

```json
{
  "extends": [
    "@dotli/typescript-config/base.json",
    "@dotli/typescript-config/paths.json",
    "@dotli/typescript-config/solid.json"
  ],
  "include": ["src"]
}
```

If an app tsconfig has a single string `extends`, convert it to an array with the existing value first.

- [ ] **Step 3: Write the probe component test (fails: component and helper don't exist)**

Create `packages/ui/tests/components/solid-probe.test.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { SolidProbe } from "@dotli/ui/components/dev/SolidProbe";
import { renderComponent, settle } from "../helpers/solid";

describe("Solid toolchain probe", () => {
  it("As a dotli developer, a Solid component renders, reacts to a click, and toggles a Show branch", async () => {
    // Given
    const view = renderComponent(() => <SolidProbe label="Taps" />);
    const button = view.getByRole("button");
    expect(button.textContent).toBe("Taps: 0");
    expect(view.queryByText("Tapped")).toBeNull();

    // When
    fireEvent.click(button);
    await settle();

    // Then
    expect(button.textContent).toBe("Taps: 1");
    expect(button.classList.contains("solid-probe")).toBe(true);
    expect(view.getByText("Tapped")).toBeTruthy();
  });
});
```

- [ ] **Step 4: Widen Vitest includes and add the plugin, then run the test to see it fail**

`packages/ui/vitest.config.ts` becomes:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@dotli/ui": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "happy-dom",
    globals: false,
  },
  define: {
    // getEnabledNetworks() requires VITE_NETWORKS (no default by design); the
    // test build supplies it the same way a deployment does.
    "import.meta.env.VITE_NETWORKS": '"paseo-next-v2,previewnet"',
  },
});
```

`apps/host/vitest.config.ts`: add `import solid from "@solidjs/vite-plugin";`, `plugins: [solid()],` above `test`, and change `include` to `["tests/unit/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"]`.

`apps/sandbox/vitest.config.ts`: add the same import and `plugins: [solid()]`, and change every `*.test.ts` glob in `include` to `*.test.{ts,tsx}`.

Run: `bun run --cwd packages/ui vitest run tests/components/solid-probe.test.tsx`
Expected: FAIL — cannot resolve `@dotli/ui/components/dev/SolidProbe` (or `../helpers/solid`).

- [ ] **Step 5: Write the test helper**

Create `packages/ui/tests/helpers/solid.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { flush } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

/** Render a Solid view into a fresh container. Cleaned up after each test. */
export function renderComponent(
  view: () => JSX.Element,
): ReturnType<typeof render> {
  return render(view);
}

/**
 * Apply batched Solid updates, then let queued microtasks run. Solid 2 batches
 * writes, so assertions after an event or a store write come after this.
 */
export async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
}
```

- [ ] **Step 6: Write the probe component**

Create `packages/ui/src/components/dev/SolidProbe.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Toolchain proof for the Solid migration (sub-project 0). Not imported by any
// app code. Deleted in sub-project 1 once real components exist.

import { createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

export function SolidProbe(props: { label: string }): JSX.Element {
  const [count, setCount] = createSignal(0);
  return (
    <div>
      <button
        type="button"
        class={["solid-probe", { "solid-probe-used": count() > 0 }]}
        onClick={() => setCount((n) => n + 1)}
      >
        {props.label}: {count()}
      </button>
      <Show when={count() > 0}>
        <span>Tapped</span>
      </Show>
    </div>
  );
}
```

- [ ] **Step 7: Run the probe test**

Run: `bun run --cwd packages/ui vitest run tests/components/solid-probe.test.tsx`
Expected: PASS. If `getByRole` fails because the text node splits, keep the assertion on `textContent` as written; do not loosen it to `toContain`.

- [ ] **Step 8: Add the Solid plugin to the host and sandbox Vite builds**

`apps/host/vite.config.ts`: add `import solid from "@solidjs/vite-plugin";` with the other imports, and make `solid({ ssr: true }),` the first entry of `plugins`, before `wasm()`:

```ts
  plugins: [
    // Hydratable client output. Nothing renders a component yet; the
    // prerender step that uses it arrives in sub-project 4.
    solid({ ssr: true }),
    wasm(),
```

`apps/sandbox/vite.config.ts`: add the same import and `solid(),` as the first entry of the **top-level** `plugins` array only. Do not add it to the nested service-worker `viteBuild` call.

Run: `VITE_NETWORKS=paseo-next-v2,previewnet bun run build`
Expected: succeeds for host, sandbox, and protocol.

- [ ] **Step 9: Add ESLint rules for `.tsx`**

Try the Solid plugin first:

```bash
bun add --cwd packages/eslint-config -d eslint-plugin-solid@0.18.0
```

Append to the `config` array in `packages/eslint-config/vite.js` (after the existing blocks, so it overrides them):

```js
  {
    files: ["**/*.tsx"],
    plugins: { solid },
    rules: {
      ...solid.configs["flat/typescript"].rules,
      // Components return JSX.Element by inference; annotating every one adds
      // noise without catching anything.
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
```

with `import solid from "eslint-plugin-solid";` at the top.

Run: `bun run --cwd packages/ui lint` (the package lint script covers `src/`, which includes `SolidProbe.tsx`).

Expected: no errors. **If** `eslint-plugin-solid` reports errors on the probe that are wrong for Solid 2 (for example it flags `class={[…]}` arrays, which Solid 2 supports), remove the plugin (`bun remove --cwd packages/eslint-config eslint-plugin-solid`), keep the block without `plugins` and the spread, and put this comment above it:

```js
  // eslint-plugin-solid 0.18 targets Solid 1 JSX and misreports Solid 2 syntax
  // (class arrays/objects). Re-enable once it supports Solid 2.
```

- [ ] **Step 10: Typecheck, lint, and test everything**

```bash
bun run typecheck && bun run lint && bun run test
```

Expected: all green. Existing suites must pass unchanged.

- [ ] **Step 11: Commit**

```bash
git add package.json bun.lock packages/typescript-config/solid.json \
  packages/*/package.json apps/*/package.json \
  packages/ui/tsconfig.json packages/truapi-debug/tsconfig.json packages/sandbox-checker/tsconfig.json \
  apps/host/tsconfig.json apps/sandbox/tsconfig.json \
  apps/host/vite.config.ts apps/sandbox/vite.config.ts \
  packages/ui/vitest.config.ts apps/host/vitest.config.ts apps/sandbox/vitest.config.ts \
  packages/eslint-config/vite.js \
  packages/ui/src/components/dev/SolidProbe.tsx \
  packages/ui/tests/helpers/solid.ts packages/ui/tests/components/solid-probe.test.tsx
git commit -m "build: add pinned Solid 2 RC toolchain (TS, Vite, Vitest, ESLint)"
```

---

### Task 3: Generic store primitive

**Files:**
- Create: `packages/ui/src/state/create-store.ts`
- Test: `packages/ui/tests/state/create-store.test.ts`
- Modify: `packages/ui/tests/helpers/solid.ts` (re-export reset)

**Interfaces:**
- Consumes: `settle()` from Task 2.
- Produces:
  ```ts
  export interface SyncStore<T> {
    /** Reactive accessor. Components only. */
    read: () => T;
    /** Latest written value, immediately. For non-UI code. */
    get: () => T;
    /** The only writer. */
    set: (next: T) => void;
    /** Restore the initial value. Tests only. */
    reset: () => void;
  }
  export function createSyncStore<T>(initial: T): SyncStore<T>;
  export function resetAllStoresForTests(): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/ui/tests/state/create-store.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { createRoot, createEffect } from "solid-js";
import {
  createSyncStore,
  resetAllStoresForTests,
} from "@dotli/ui/state/create-store";
import { settle } from "../helpers/solid";

describe("createSyncStore", () => {
  it("As non-UI code, the sync getter returns the value just set, before any flush", () => {
    // Given
    const store = createSyncStore<{ n: number }>({ n: 0 });

    // When
    store.set({ n: 1 });

    // Then
    expect(store.get()).toEqual({ n: 1 });
  });

  it("As a component, the reactive accessor sees the new value after settle and re-runs dependants", async () => {
    // Given
    const store = createSyncStore(0);
    const seen: number[] = [];
    const dispose = createRoot((d) => {
      createEffect(
        () => store.read(),
        (value) => {
          seen.push(value);
        },
      );
      return d;
    });
    await settle();

    // When
    store.set(5);
    await settle();

    // Then
    expect(store.read()).toBe(5);
    expect(seen).toEqual([0, 5]);
    dispose();
  });

  it("As a test author, resetAllStoresForTests restores every store to its initial value", async () => {
    // Given
    const a = createSyncStore("a");
    const b = createSyncStore<string[]>([]);
    a.set("changed");
    b.set(["x"]);

    // When
    resetAllStoresForTests();
    await settle();

    // Then
    expect(a.get()).toBe("a");
    expect(b.get()).toEqual([]);
    expect(a.read()).toBe("a");
  });

  it("As non-UI code, storing a function-free object never invokes it as an updater", () => {
    // Given
    const store = createSyncStore<{ tag: string }>({ tag: "Disconnected" });

    // When
    store.set({ tag: "Connected" });

    // Then
    expect(store.get().tag).toBe("Connected");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/ui vitest run tests/state/create-store.test.ts`
Expected: FAIL — cannot resolve `@dotli/ui/state/create-store`.

- [ ] **Step 3: Implement**

Create `packages/ui/src/state/create-store.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A value held twice: in a plain variable for non-UI code, and in a Solid
 * signal for components.
 *
 * Solid 2 batches signal writes, so reading a signal right after writing it
 * outside a reactive scope returns the old value until the next flush. Non-UI
 * code (the bridge, host callbacks) writes then reads within one call, so it
 * reads `get()`, which is always current. Components read `read()` and see the
 * change after the flush.
 */

import { createSignal } from "solid-js";

export interface SyncStore<T> {
  /** Reactive accessor. Components only. */
  read: () => T;
  /** Latest written value, immediately. For non-UI code. */
  get: () => T;
  /** The only writer. */
  set: (next: T) => void;
  /** Restore the initial value. Tests only. */
  reset: () => void;
}

const registry = new Set<() => void>();

export function createSyncStore<T>(initial: T): SyncStore<T> {
  let current = initial;
  // Value form, not a compute function: in Solid 2 a function first argument
  // makes a derived signal. The cast is needed because the value overload
  // excludes function types; stores never hold functions.
  const [read, write] = createSignal<T>(initial as Exclude<T, Function>);
  const set = (next: T): void => {
    current = next;
    // Wrapped so a function-valued T is stored, not called as an updater.
    write(() => next);
  };
  const reset = (): void => {
    set(initial);
  };
  registry.add(reset);
  return { read, get: () => current, set, reset };
}

/** Restore every store created so far to its initial value. Tests only. */
export function resetAllStoresForTests(): void {
  for (const reset of registry) {
    reset();
  }
}
```

If lint flags the `Function` type (`@typescript-eslint/no-unsafe-function-type`), add `// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors createSignal's own overload` above that line.

- [ ] **Step 4: Run the test**

Run: `bun run --cwd packages/ui vitest run tests/state/create-store.test.ts`
Expected: PASS (4 tests). If `createEffect(compute, apply)` warns about running outside an owner, it is inside `createRoot`, so a warning means the test is wrong — fix the test, not the store.

- [ ] **Step 5: Re-export reset from the test helper**

Append to `packages/ui/tests/helpers/solid.ts`:

```ts
export { resetAllStoresForTests as resetStores } from "@dotli/ui/state/create-store";
```

- [ ] **Step 6: Lint, typecheck, commit**

```bash
bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint
git add packages/ui/src/state/create-store.ts packages/ui/tests/state/create-store.test.ts packages/ui/tests/helpers/solid.ts
git commit -m "feat(ui): add createSyncStore, a sync + reactive store primitive"
```

---

### Task 4: Auth store

**Files:**
- Create: `packages/ui/src/state/auth.ts`
- Modify: `packages/ui/src/host-callbacks/AuthState.ts:30-37`
- Modify: `packages/ui/src/topbar.ts:520-526` (`renderLoggedOut`), `:528-544` (`renderTruapiLoggedIn`)
- Test: `packages/ui/tests/state/auth.test.ts`

**Interfaces:**
- Consumes: `createSyncStore` (Task 3); type `DotliAuthState` from `packages/ui/src/host-callbacks/AuthState.ts`.
- Produces:
  ```ts
  export const authState: () => DotliAuthState;
  export function getAuthState(): DotliAuthState;
  export function setAuthState(next: DotliAuthState): void;   // dispatches "dotli:truapi-auth-state"
  export const loggedIn: () => boolean;
  export function getLoggedIn(): boolean;
  export function setLoggedIn(next: boolean): void;           // dispatches "dotli:authenticated" | "dotli:logged-out"
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/ui/tests/state/auth.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authState,
  getAuthState,
  getLoggedIn,
  loggedIn,
  setAuthState,
  setLoggedIn,
} from "@dotli/ui/state/auth";
import { dispatchAuthState } from "@dotli/ui/host-callbacks/AuthState";
import { resetStores, settle } from "../helpers/solid";

describe("auth store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the topbar, the auth store starts Disconnected and logged out", () => {
    // Then
    expect(getAuthState()).toEqual({ tag: "Disconnected" });
    expect(getLoggedIn()).toBe(false);
  });

  it("As a listener of dotli:truapi-auth-state, the event carries the same detail and the store already holds it", async () => {
    // Given
    const seen: { detail: unknown; storeTag: string }[] = [];
    const listener = (e: Event): void => {
      seen.push({
        detail: (e as CustomEvent).detail,
        storeTag: getAuthState().tag,
      });
    };
    window.addEventListener("dotli:truapi-auth-state", listener);

    // When
    setAuthState({ tag: "Authenticating" });
    await settle();

    // Then
    expect(seen).toEqual([
      { detail: { tag: "Authenticating" }, storeTag: "Authenticating" },
    ]);
    expect(authState()).toEqual({ tag: "Authenticating" });
    window.removeEventListener("dotli:truapi-auth-state", listener);
  });

  it("As the TrUAPI host callback, dispatchAuthState writes through the store", () => {
    // When
    dispatchAuthState({ tag: "Authenticating" });

    // Then
    expect(getAuthState()).toEqual({ tag: "Authenticating" });
  });

  it("As a listener, setLoggedIn fires dotli:authenticated and dotli:logged-out exactly as before", async () => {
    // Given
    const events: string[] = [];
    const onAuth = vi.fn(() => events.push("authenticated"));
    const onOut = vi.fn(() => events.push("logged-out"));
    window.addEventListener("dotli:authenticated", onAuth);
    window.addEventListener("dotli:logged-out", onOut);

    // When
    setLoggedIn(true);
    setLoggedIn(false);
    await settle();

    // Then
    expect(events).toEqual(["authenticated", "logged-out"]);
    expect(loggedIn()).toBe(false);
    window.removeEventListener("dotli:authenticated", onAuth);
    window.removeEventListener("dotli:logged-out", onOut);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/ui vitest run tests/state/auth.test.ts`
Expected: FAIL — cannot resolve `@dotli/ui/state/auth`.

- [ ] **Step 3: Implement the store**

Create `packages/ui/src/state/auth.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotliAuthState } from "../host-callbacks/AuthState";
import { createSyncStore } from "./create-store";

const auth = createSyncStore<DotliAuthState>({ tag: "Disconnected" });
const session = createSyncStore<boolean>(false);

export const authState = auth.read;
export const getAuthState = auth.get;

/**
 * Also dispatches `dotli:truapi-auth-state` with the same detail as before:
 * the e2e global setup and the topbar and chat panel listen for it.
 */
export function setAuthState(next: DotliAuthState): void {
  auth.set(next);
  window.dispatchEvent(
    new CustomEvent<DotliAuthState>("dotli:truapi-auth-state", {
      detail: next,
    }),
  );
}

export const loggedIn = session.read;
export const getLoggedIn = session.get;

/** Also dispatches `dotli:authenticated` or `dotli:logged-out`, as the topbar did. */
export function setLoggedIn(next: boolean): void {
  session.set(next);
  window.dispatchEvent(
    new Event(next ? "dotli:authenticated" : "dotli:logged-out"),
  );
}
```

- [ ] **Step 4: Route the producers through the store**

In `packages/ui/src/host-callbacks/AuthState.ts`, replace the body of `dispatchAuthState` (lines 30-37) and add the import at the top of the file, after the existing imports:

```ts
import { setAuthState } from "../state/auth";
```

```ts
/** Record the auth state; the store dispatches `dotli:truapi-auth-state`. */
export function dispatchAuthState(state: DotliAuthState): void {
  setAuthState(state);
}
```

In `packages/ui/src/topbar.ts`:
- add `import { setLoggedIn } from "@dotli/ui/state/auth";` with the other `@dotli/ui/*` imports;
- in `renderLoggedOut`, replace `window.dispatchEvent(new Event("dotli:logged-out"));` with `setLoggedIn(false);`;
- in `renderTruapiLoggedIn`, replace `window.dispatchEvent(new Event("dotli:authenticated"));` with `setLoggedIn(true);`.

- [ ] **Step 5: Run the store test**

Run: `bun run --cwd packages/ui vitest run tests/state/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the suites that listen to these events**

Run: `bun run --cwd packages/ui vitest run tests/topbar.test.ts tests/chat-panel.test.ts tests/bridge.test.ts tests/session-store.test.ts`
Expected: PASS, with no test file edited. These suites use `vi.resetModules()` and re-import, which also creates a fresh store; a failure here means the store changed event timing or detail — fix the store, not the test.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint
git add packages/ui/src/state/auth.ts packages/ui/src/host-callbacks/AuthState.ts packages/ui/src/topbar.ts packages/ui/tests/state/auth.test.ts
git commit -m "feat(ui): add auth store and route auth events through it"
```

---

### Task 5: Product store

**Files:**
- Create: `packages/ui/src/state/product.ts`
- Modify: `packages/ui/src/bridge.ts:1066-1075` and `:1242-1248` (`dotli:product-loaded` dispatches)
- Modify: `packages/ui/src/ui.ts:782` and `:833` (`dotli:product-error` dispatches)
- Test: `packages/ui/tests/state/product.test.ts`

**Interfaces:**
- Consumes: `createSyncStore` (Task 3).
- Produces:
  ```ts
  export type ProductState =
    | { status: "none" }
    | { status: "loaded"; label: string; productId: string }
    | { status: "error" };
  export const productState: () => ProductState;
  export function getProductState(): ProductState;
  export function setProductLoaded(label: string, productId: string): void; // dispatches "dotli:product-loaded" { label, productId }
  export function setProductError(): void;                                  // dispatches "dotli:product-error" (no detail)
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/ui/tests/state/product.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  getProductState,
  productState,
  setProductError,
  setProductLoaded,
} from "@dotli/ui/state/product";
import { resetStores, settle } from "../helpers/solid";

describe("product store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the topbar, the product store starts with no product", () => {
    expect(getProductState()).toEqual({ status: "none" });
  });

  it("As a listener of dotli:product-loaded, the detail is { label, productId } and the store is loaded", async () => {
    // Given
    const details: unknown[] = [];
    const listener = (e: Event): void => {
      details.push((e as CustomEvent).detail);
    };
    window.addEventListener("dotli:product-loaded", listener);

    // When
    setProductLoaded("myapp", "myapp.dot");
    await settle();

    // Then
    expect(details).toEqual([{ label: "myapp", productId: "myapp.dot" }]);
    expect(productState()).toEqual({
      status: "loaded",
      label: "myapp",
      productId: "myapp.dot",
    });
    window.removeEventListener("dotli:product-loaded", listener);
  });

  it("As a listener of dotli:product-error, the event fires with no detail and the store is in error", () => {
    // Given
    const details: unknown[] = [];
    const listener = (e: Event): void => {
      details.push((e as CustomEvent).detail);
    };
    window.addEventListener("dotli:product-error", listener);

    // When
    setProductError();

    // Then
    expect(details).toEqual([null]);
    expect(getProductState()).toEqual({ status: "error" });
    window.removeEventListener("dotli:product-error", listener);
  });
});
```

(`new CustomEvent(name)` without a detail has `detail === null`; that is what the current producers dispatch.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/ui vitest run tests/state/product.test.ts`
Expected: FAIL — cannot resolve `@dotli/ui/state/product`.

- [ ] **Step 3: Implement**

Create `packages/ui/src/state/product.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore } from "./create-store";

export type ProductState =
  | { status: "none" }
  | { status: "loaded"; label: string; productId: string }
  | { status: "error" };

const product = createSyncStore<ProductState>({ status: "none" });

export const productState = product.read;
export const getProductState = product.get;

/** Also dispatches `dotli:product-loaded` with `{ label, productId }`. */
export function setProductLoaded(label: string, productId: string): void {
  product.set({ status: "loaded", label, productId });
  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", { detail: { label, productId } }),
  );
}

/** Also dispatches `dotli:product-error` with no detail. */
export function setProductError(): void {
  product.set({ status: "error" });
  window.dispatchEvent(new CustomEvent("dotli:product-error"));
}
```

- [ ] **Step 4: Route the producers**

`packages/ui/src/bridge.ts`: add `import { setProductLoaded } from "./state/product";` with the other relative imports. Replace the first dispatch block (around line 1066):

```ts
  // Carry the runtime productId so listeners key chat data the same way
  // storage does when the debug path overrides the label-derived id.
  setProductLoaded(label, options.productId ?? labelToProductId(label));
```

and the second (around line 1242):

```ts
  setProductLoaded(label, labelToProductId(label));
```

`packages/ui/src/ui.ts`: add `import { setProductError } from "./state/product";`, then replace both `window.dispatchEvent(new CustomEvent("dotli:product-error"));` lines (around 782 and 833) with `setProductError();`.

Confirm no other producer remains:

```bash
grep -rn '"dotli:product-loaded"\|"dotli:product-error"' packages/ui/src | grep dispatchEvent
```

Expected: only the two lines inside `packages/ui/src/state/product.ts`.

- [ ] **Step 5: Run tests**

Run: `bun run --cwd packages/ui vitest run tests/state/product.test.ts tests/bridge.test.ts tests/error-page.test.ts tests/chat-panel.test.ts tests/topbar.test.ts`
Expected: PASS, no test file edited.

Also run the sandbox suite, since `ui.ts` is imported there: `bun run --cwd apps/sandbox test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint
git add packages/ui/src/state/product.ts packages/ui/src/bridge.ts packages/ui/src/ui.ts packages/ui/tests/state/product.test.ts
git commit -m "feat(ui): add product store and route product events through it"
```

---

### Task 6: Permissions store

**Files:**
- Create: `packages/ui/src/state/permissions.ts`
- Modify: `packages/ui/src/host-callbacks/PromptPermission.ts:159-180`
- Test: `packages/ui/tests/state/permissions.test.ts`

**Interfaces:**
- Consumes: `createSyncStore` (Task 3).
- Produces:
  ```ts
  export type PermissionChange =
    | { kind: "grant"; label: string }
    | { kind: "device"; label: string; permission: string };
  export interface PermissionsState { version: number; last: PermissionChange | null }
  export const permissionsState: () => PermissionsState;
  export function getPermissionsState(): PermissionsState;
  export function recordPermissionChange(change: PermissionChange): void;
  // grant  -> dispatches "dotli:permission-changed" { label }
  // device -> dispatches "dotli:device-permission-changed" { label, permission }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/ui/tests/state/permissions.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  getPermissionsState,
  permissionsState,
  recordPermissionChange,
} from "@dotli/ui/state/permissions";
import { resetStores, settle } from "../helpers/solid";

function capture(name: string): { details: unknown[]; stop: () => void } {
  const details: unknown[] = [];
  const listener = (e: Event): void => {
    details.push((e as CustomEvent).detail);
  };
  window.addEventListener(name, listener);
  return {
    details,
    stop: () => {
      window.removeEventListener(name, listener);
    },
  };
}

describe("permissions store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the permissions popover, the store starts at version 0 with no change", () => {
    expect(getPermissionsState()).toEqual({ version: 0, last: null });
  });

  it("As a listener, a grant bumps the version and fires dotli:permission-changed { label }", async () => {
    // Given
    const events = capture("dotli:permission-changed");

    // When
    recordPermissionChange({ kind: "grant", label: "myapp" });
    await settle();

    // Then
    expect(events.details).toEqual([{ label: "myapp" }]);
    expect(permissionsState()).toEqual({
      version: 1,
      last: { kind: "grant", label: "myapp" },
    });
    events.stop();
  });

  it("As a listener, a device change fires dotli:device-permission-changed { label, permission }", () => {
    // Given
    const events = capture("dotli:device-permission-changed");

    // When
    recordPermissionChange({ kind: "device", label: "myapp", permission: "camera" });
    recordPermissionChange({ kind: "device", label: "myapp", permission: "camera" });

    // Then
    expect(events.details).toEqual([
      { label: "myapp", permission: "camera" },
      { label: "myapp", permission: "camera" },
    ]);
    expect(getPermissionsState().version).toBe(2);
    events.stop();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/ui vitest run tests/state/permissions.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement**

Create `packages/ui/src/state/permissions.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Permission statuses stay in `permissions.ts` (async, per product). This
 * store only counts changes so components know when to re-read them.
 */

import { createSyncStore } from "./create-store";

export type PermissionChange =
  | { kind: "grant"; label: string }
  | { kind: "device"; label: string; permission: string };

export interface PermissionsState {
  version: number;
  last: PermissionChange | null;
}

const permissions = createSyncStore<PermissionsState>({
  version: 0,
  last: null,
});

export const permissionsState = permissions.read;
export const getPermissionsState = permissions.get;

/**
 * Also dispatches the event the topbar and bridge listen for:
 * `dotli:permission-changed` for grants, `dotli:device-permission-changed`
 * for device permissions (the bridge reloads the iframe on it).
 */
export function recordPermissionChange(change: PermissionChange): void {
  permissions.set({ version: permissions.get().version + 1, last: change });
  if (change.kind === "grant") {
    window.dispatchEvent(
      new CustomEvent("dotli:permission-changed", {
        detail: { label: change.label },
      }),
    );
    return;
  }
  window.dispatchEvent(
    new CustomEvent("dotli:device-permission-changed", {
      detail: { label: change.label, permission: change.permission },
    }),
  );
}
```

- [ ] **Step 4: Route the producers**

In `packages/ui/src/host-callbacks/PromptPermission.ts` add `import { recordPermissionChange } from "../state/permissions";` and replace the two dispatches (lines ~168-180). The result:

```ts
  if (gatedByIframe) {
    // Device permissions are also gated by the iframe `allow` attribute,
    // which is fixed at iframe load time. Reload so the next attempt sees
    // the updated attribute. Defer to the next tick so the prompt response
    // can flush before the iframe is disposed.
    setTimeout(() => {
      if (signal.aborted) {
        return;
      }
      recordPermissionChange({ kind: "device", label, permission: name });
    }, 0);
  } else {
    // No browser-level gate, so the grant takes effect as is. The event keeps
    // the topbar in sync.
    recordPermissionChange({ kind: "grant", label });
  }
```

If `name` is typed as a narrower union than `string`, the assignment still type-checks because `PermissionChange.permission` is `string`.

- [ ] **Step 5: Run tests**

Run: `bun run --cwd packages/ui vitest run tests/state/permissions.test.ts tests/permissions.test.ts tests/permission-modal.test.ts tests/topbar.test.ts tests/bridge.test.ts`
Expected: PASS, no existing test file edited.

- [ ] **Step 6: Commit**

```bash
bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint
git add packages/ui/src/state/permissions.ts packages/ui/src/host-callbacks/PromptPermission.ts packages/ui/tests/state/permissions.test.ts
git commit -m "feat(ui): add permissions change store and route permission events through it"
```

---

### Task 7: Chat store

**Files:**
- Create: `packages/ui/src/state/chat.ts`
- Modify: `packages/ui/src/chat/service.ts:76-78` (`emit`), and the four `emit(...)` call sites (`:87`, `:106`, `:140`, `:216`)
- Modify: `apps/host/src/main.ts` (call `initChatStore()` next to `initTopBar`, around line 1036)
- Test: `packages/ui/tests/state/chat.test.ts`

**Interfaces:**
- Consumes: `createSyncStore` (Task 3); `CHAT_ROOMS_CHANGED_EVENT`, `CHAT_BOTS_CHANGED_EVENT`, `CHAT_MESSAGE_EVENT`, `ChatMessageEventDetail` from `packages/ui/src/chat/service.ts`; `CHAT_AVAILABILITY_EVENT`, `ChatAvailabilityDetail` from `@dotli/shared/chat-capability`.
- Produces:
  ```ts
  export interface ChatState {
    availability: ChatAvailabilityDetail | null;
    roomsVersion: number;
    botsVersion: number;
    lastMessage: ChatMessageEventDetail | null;
  }
  export const chatState: () => ChatState;
  export function getChatState(): ChatState;
  export function recordRoomsChanged(productId: string): void;              // dispatches CHAT_ROOMS_CHANGED_EVENT { productId }
  export function recordBotsChanged(productId: string): void;               // dispatches CHAT_BOTS_CHANGED_EVENT { productId }
  export function recordMessage(detail: ChatMessageEventDetail): void;      // dispatches CHAT_MESSAGE_EVENT detail
  export function initChatStore(): () => void;  // listens to CHAT_AVAILABILITY_EVENT; returns remove
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/ui/tests/state/chat.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  chatState,
  getChatState,
  initChatStore,
  recordBotsChanged,
  recordMessage,
  recordRoomsChanged,
} from "@dotli/ui/state/chat";
import {
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
} from "@dotli/ui/chat/service";
import { CHAT_AVAILABILITY_EVENT } from "@dotli/shared/chat-capability";
import { resetStores, settle } from "../helpers/solid";

function capture(name: string): { details: unknown[]; stop: () => void } {
  const details: unknown[] = [];
  const listener = (e: Event): void => {
    details.push((e as CustomEvent).detail);
  };
  window.addEventListener(name, listener);
  return {
    details,
    stop: () => {
      window.removeEventListener(name, listener);
    },
  };
}

describe("chat store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the chat panel, the store starts empty", () => {
    expect(getChatState()).toEqual({
      availability: null,
      roomsVersion: 0,
      botsVersion: 0,
      lastMessage: null,
    });
  });

  it("As a chat listener, rooms, bots and message changes keep their event names and details", async () => {
    // Given
    const rooms = capture(CHAT_ROOMS_CHANGED_EVENT);
    const bots = capture(CHAT_BOTS_CHANGED_EVENT);
    const messages = capture(CHAT_MESSAGE_EVENT);
    const msg = { productId: "p", roomId: "r", author: "user" as const };

    // When
    recordRoomsChanged("p");
    recordBotsChanged("p");
    recordMessage(msg);
    await settle();

    // Then
    expect(rooms.details).toEqual([{ productId: "p" }]);
    expect(bots.details).toEqual([{ productId: "p" }]);
    expect(messages.details).toEqual([msg]);
    expect(chatState()).toMatchObject({
      roomsVersion: 1,
      botsVersion: 1,
      lastMessage: msg,
    });
    rooms.stop();
    bots.stop();
    messages.stop();
  });

  it("As the chat panel, availability announced by @dotli/shared lands in the store once initChatStore runs", () => {
    // Given
    const stop = initChatStore();

    // When
    window.dispatchEvent(
      new CustomEvent(CHAT_AVAILABILITY_EVENT, {
        detail: { label: "myapp", chat: true },
      }),
    );

    // Then
    expect(getChatState().availability).toEqual({ label: "myapp", chat: true });
    stop();
  });

  it("As the host, stopping the chat store stops tracking availability", () => {
    // Given
    const stop = initChatStore();
    stop();

    // When
    window.dispatchEvent(
      new CustomEvent(CHAT_AVAILABILITY_EVENT, {
        detail: { label: "other", chat: false },
      }),
    );

    // Then
    expect(getChatState().availability).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/ui vitest run tests/state/chat.test.ts`
Expected: FAIL — cannot resolve `@dotli/ui/state/chat`.

- [ ] **Step 3: Implement**

Create `packages/ui/src/state/chat.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  CHAT_AVAILABILITY_EVENT,
  type ChatAvailabilityDetail,
} from "@dotli/shared/chat-capability";
import {
  CHAT_BOTS_CHANGED_EVENT,
  CHAT_MESSAGE_EVENT,
  CHAT_ROOMS_CHANGED_EVENT,
  type ChatMessageEventDetail,
} from "../chat/service";
import { createSyncStore } from "./create-store";

export interface ChatState {
  availability: ChatAvailabilityDetail | null;
  roomsVersion: number;
  botsVersion: number;
  lastMessage: ChatMessageEventDetail | null;
}

const chat = createSyncStore<ChatState>({
  availability: null,
  roomsVersion: 0,
  botsVersion: 0,
  lastMessage: null,
});

export const chatState = chat.read;
export const getChatState = chat.get;

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Also dispatches `dotli:chat-rooms-changed` with `{ productId }`. */
export function recordRoomsChanged(productId: string): void {
  chat.set({ ...chat.get(), roomsVersion: chat.get().roomsVersion + 1 });
  emit(CHAT_ROOMS_CHANGED_EVENT, { productId });
}

/** Also dispatches `dotli:chat-bots-changed` with `{ productId }`. */
export function recordBotsChanged(productId: string): void {
  chat.set({ ...chat.get(), botsVersion: chat.get().botsVersion + 1 });
  emit(CHAT_BOTS_CHANGED_EVENT, { productId });
}

/** Also dispatches `dotli:chat-message` with the same detail. */
export function recordMessage(detail: ChatMessageEventDetail): void {
  chat.set({ ...chat.get(), lastMessage: detail });
  emit(CHAT_MESSAGE_EVENT, detail);
}

/**
 * Track chat availability. Its producer lives in `@dotli/shared`, which must
 * not import `@dotli/ui`, so the store listens to the event instead of being
 * called. Returns the remove function.
 */
export function initChatStore(): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<ChatAvailabilityDetail>).detail;
    chat.set({ ...chat.get(), availability: detail });
  };
  window.addEventListener(CHAT_AVAILABILITY_EVENT, listener);
  return () => {
    window.removeEventListener(CHAT_AVAILABILITY_EVENT, listener);
  };
}
```

Note the import cycle: `state/chat.ts` imports constants and a type from `chat/service.ts`, and Step 4 makes `chat/service.ts` import functions from `state/chat.ts`. ES modules handle this because both sides only use each other's exports inside functions, never at module top level. If Vitest reports `undefined` for a constant at import time, move the three `CHAT_*_EVENT` constants and `ChatMessageEventDetail` into `state/chat.ts` and re-export them from `chat/service.ts` (`export { CHAT_ROOMS_CHANGED_EVENT, … } from "../state/chat";`) so existing importers keep working.

- [ ] **Step 4: Route the producers**

In `packages/ui/src/chat/service.ts`:
- add `import { recordBotsChanged, recordMessage, recordRoomsChanged } from "../state/chat";`
- delete the local `emit` function (lines 76-78);
- replace `emit(CHAT_ROOMS_CHANGED_EVENT, { productId });` (line ~87) with `recordRoomsChanged(productId);`;
- replace both `emit(CHAT_MESSAGE_EVENT, { … });` calls (~106, ~140) with `recordMessage({ … });`, keeping the object literal unchanged;
- replace `emit(CHAT_BOTS_CHANGED_EVENT, { productId });` (~216) with `recordBotsChanged(productId);`.

In `apps/host/src/main.ts`, add `import { initChatStore } from "@dotli/ui/state/chat";` with the other `@dotli/ui` imports, and call it just before `initTopBar(blockingModalCoordinator);` (line ~1036):

```ts
  initChatStore();
```

The return value is intentionally dropped: the listener lives for the page's lifetime, like the topbar's own listeners.

- [ ] **Step 5: Run tests**

Run: `bun run --cwd packages/ui vitest run tests/state/chat.test.ts tests/chat-panel.test.ts tests/chat-custom-renderer.test.ts`
Expected: PASS, no existing test edited.
Run: `bun run --cwd apps/host test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run typecheck && bun run lint
git add packages/ui/src/state/chat.ts packages/ui/src/chat/service.ts apps/host/src/main.ts packages/ui/tests/state/chat.test.ts
git commit -m "feat(ui): add chat store and route chat events through it"
```

---

### Task 8: Topbar and theme stores

**Files:**
- Create: `packages/ui/src/state/topbar.ts`, `packages/ui/src/state/theme.ts`
- Modify: `packages/ui/src/topbar-autohide.ts:114-131` (`setVisible`)
- Modify: `packages/ui/src/blocking-modal-queue.ts:167-173` (`emitActiveChanged`)
- Modify: `packages/ui/src/topbar.ts:131` (`ThemePref` type), `:163-170` (`applyThemePref`), `:1723-1727` (`setChainsButtonVisible`)
- Test: `packages/ui/tests/state/topbar.test.ts`, `packages/ui/tests/state/theme.test.ts`

**Interfaces:**
- Consumes: `createSyncStore` (Task 3).
- Produces (`state/topbar.ts`):
  ```ts
  export interface TopbarState { visible: boolean; blockingModalActive: boolean; chainsButtonVisible: boolean }
  export const topbarState: () => TopbarState;
  export function getTopbarState(): TopbarState;
  export function setTopbarVisible(visible: boolean): void;          // dispatches "topbar:visibility" detail=boolean
  export function setBlockingModalActive(active: boolean): void;     // dispatches "dotli:blocking-modal-active" { active }
  export function setChainsButtonVisibleState(visible: boolean): void; // no event
  ```
- Produces (`state/theme.ts`):
  ```ts
  export type ThemePref = "light" | "dark" | "system";
  export interface ThemeState { pref: ThemePref; resolved: "light" | "dark" }
  export const themeState: () => ThemeState;
  export function getThemeState(): ThemeState;
  export function setTheme(next: ThemeState): void; // dispatches "dotli:theme-changed" (plain Event)
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/tests/state/topbar.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  getTopbarState,
  setBlockingModalActive,
  setChainsButtonVisibleState,
  setTopbarVisible,
  topbarState,
} from "@dotli/ui/state/topbar";
import { resetStores, settle } from "../helpers/solid";

describe("topbar store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the shell, the topbar starts visible, unblocked, with the chains button hidden", () => {
    expect(getTopbarState()).toEqual({
      visible: true,
      blockingModalActive: false,
      chainsButtonVisible: false,
    });
  });

  it("As the offline banner and chat panel, topbar:visibility still carries a boolean detail", async () => {
    // Given
    const details: unknown[] = [];
    const listener = (e: Event): void => {
      details.push((e as CustomEvent).detail);
    };
    window.addEventListener("topbar:visibility", listener);

    // When
    setTopbarVisible(false);
    await settle();

    // Then
    expect(details).toEqual([false]);
    expect(topbarState().visible).toBe(false);
    window.removeEventListener("topbar:visibility", listener);
  });

  it("As the topbar, dotli:blocking-modal-active still carries { active }", () => {
    // Given
    const details: unknown[] = [];
    const listener = (e: Event): void => {
      details.push((e as CustomEvent).detail);
    };
    window.addEventListener("dotli:blocking-modal-active", listener);

    // When
    setBlockingModalActive(true);

    // Then
    expect(details).toEqual([{ active: true }]);
    expect(getTopbarState().blockingModalActive).toBe(true);
    window.removeEventListener("dotli:blocking-modal-active", listener);
  });

  it("As the host, chains button visibility is recorded without an event", () => {
    // When
    setChainsButtonVisibleState(true);

    // Then
    expect(getTopbarState().chainsButtonVisible).toBe(true);
  });
});
```

Create `packages/ui/tests/state/theme.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { getThemeState, setTheme, themeState } from "@dotli/ui/state/theme";
import { resetStores, settle } from "../helpers/solid";

describe("theme store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the prerendered shell, the theme store defaults to system/dark without reading matchMedia", () => {
    expect(getThemeState()).toEqual({ pref: "system", resolved: "dark" });
  });

  it("As the TrUAPI theme bridge, setTheme still fires a plain dotli:theme-changed event", async () => {
    // Given
    let fired = 0;
    const listener = (): void => {
      fired += 1;
    };
    window.addEventListener("dotli:theme-changed", listener);

    // When
    setTheme({ pref: "light", resolved: "light" });
    await settle();

    // Then
    expect(fired).toBe(1);
    expect(themeState()).toEqual({ pref: "light", resolved: "light" });
    window.removeEventListener("dotli:theme-changed", listener);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run --cwd packages/ui vitest run tests/state/topbar.test.ts tests/state/theme.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both stores**

Create `packages/ui/src/state/topbar.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore } from "./create-store";

export interface TopbarState {
  visible: boolean;
  blockingModalActive: boolean;
  chainsButtonVisible: boolean;
}

const topbar = createSyncStore<TopbarState>({
  visible: true,
  blockingModalActive: false,
  chainsButtonVisible: false,
});

export const topbarState = topbar.read;
export const getTopbarState = topbar.get;

/** Also dispatches `topbar:visibility` with the boolean as detail. */
export function setTopbarVisible(visible: boolean): void {
  topbar.set({ ...topbar.get(), visible });
  window.dispatchEvent(
    new CustomEvent<boolean>("topbar:visibility", { detail: visible }),
  );
}

/** Also dispatches `dotli:blocking-modal-active` with `{ active }`. */
export function setBlockingModalActive(active: boolean): void {
  topbar.set({ ...topbar.get(), blockingModalActive: active });
  window.dispatchEvent(
    new CustomEvent("dotli:blocking-modal-active", { detail: { active } }),
  );
}

export function setChainsButtonVisibleState(visible: boolean): void {
  topbar.set({ ...topbar.get(), chainsButtonVisible: visible });
}
```

Create `packages/ui/src/state/theme.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore } from "./create-store";

export type ThemePref = "light" | "dark" | "system";

export interface ThemeState {
  pref: ThemePref;
  resolved: "light" | "dark";
}

// Dark is the stylesheet default; the real value is written at boot by the
// topbar, which reads localStorage and matchMedia.
const theme = createSyncStore<ThemeState>({ pref: "system", resolved: "dark" });

export const themeState = theme.read;
export const getThemeState = theme.get;

/** Also dispatches `dotli:theme-changed`, which the TrUAPI theme bridge forwards. */
export function setTheme(next: ThemeState): void {
  theme.set(next);
  window.dispatchEvent(new Event("dotli:theme-changed"));
}
```

- [ ] **Step 4: Route the producers**

`packages/ui/src/topbar-autohide.ts`: add `import { setTopbarVisible } from "./state/topbar";` and in `setVisible` (line ~130) replace

```ts
  window.dispatchEvent(
    new CustomEvent<boolean>("topbar:visibility", { detail: next }),
  );
```

with `setTopbarVisible(next);`.

`packages/ui/src/blocking-modal-queue.ts`: add `import { setBlockingModalActive } from "./state/topbar";` and make the method body:

```ts
  private emitActiveChanged(active: boolean): void {
    setBlockingModalActive(active);
  }
```

`packages/ui/src/topbar.ts`:
- delete the local `type ThemePref = "light" | "dark" | "system";` (line 131) and add `import { setTheme, type ThemePref } from "@dotli/ui/state/theme";` plus `import { setChainsButtonVisibleState } from "@dotli/ui/state/topbar";`;
- `applyThemePref` becomes:
  ```ts
  function applyThemePref(pref: ThemePref): void {
    const resolved = resolveTheme(pref);
    // data-theme-pref drives the toggle icon, data-theme the actual colours.
    document.documentElement.setAttribute("data-theme-pref", pref);
    document.documentElement.setAttribute("data-theme", resolved);
    // The store notifies the Rust bridge to forward the new theme to the
    // embedded dApp.
    setTheme({ pref, resolved });
  }
  ```
- `setChainsButtonVisible` becomes:
  ```ts
  export function setChainsButtonVisible(visible: boolean): void {
    setChainsButtonVisibleState(visible);
    document
      .getElementById("chains-button")
      ?.classList.toggle("visible", visible);
  }
  ```

- [ ] **Step 5: Run tests**

Run: `bun run --cwd packages/ui vitest run tests/state/topbar.test.ts tests/state/theme.test.ts tests/topbar.test.ts tests/topbar-autohide.test.ts tests/blocking-modal-queue.test.ts tests/theme.test.ts tests/chains-bars.test.ts`
Expected: PASS, no existing test edited.
Run: `bun run --cwd apps/host test` (covers `offline.ts`, which listens to `topbar:visibility`).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run typecheck && bun run lint
git add packages/ui/src/state/topbar.ts packages/ui/src/state/theme.ts packages/ui/src/topbar-autohide.ts packages/ui/src/blocking-modal-queue.ts packages/ui/src/topbar.ts packages/ui/tests/state/topbar.test.ts packages/ui/tests/state/theme.test.ts
git commit -m "feat(ui): add topbar and theme stores and route their events through them"
```

---

### Task 9: Network and settings stores

**Files:**
- Create: `packages/ui/src/state/network.ts`, `packages/ui/src/state/settings.ts`
- Modify: `apps/host/src/main.ts` (call `initSettingsStore()` right after `applyUrlSettings` runs in `main()`)
- Test: `packages/ui/tests/state/network.test.ts`, `packages/ui/tests/state/settings.test.ts`

**Interfaces:**
- Consumes: `createSyncStore` (Task 3); `subscribeNetwork`, `getNetworkStatus`, `getTransfer`, type `ChainStatus` from `packages/ui/src/network-monitor.ts`; `getBackend`, `getCacheSettings`, types `Backend`, `CacheSettings` from `@dotli/config/mode`; `getNetwork`, `getEnabledNetworks`, type `Network` from `@dotli/config/network`.
- Produces:
  ```ts
  // state/network.ts
  export interface NetworkState { chains: ChainStatus[]; transfer: ReturnType<typeof getTransfer> }
  export const networkState: () => NetworkState;
  export function getNetworkState(): NetworkState;
  export function startNetworkStore(): () => void;  // subscribes, returns unsubscribe
  // state/settings.ts
  export interface SettingsState { backend: Backend; cache: CacheSettings; network: Network; enabledNetworks: Network[] }
  export const settingsState: () => SettingsState | null;
  export function getSettingsState(): SettingsState | null;
  export function initSettingsStore(): void;
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/tests/state/network.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../helpers/solid";

const monitor = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    status: [] as unknown[],
    transfer: { bytesPerSecond: null, fetched: null, total: null } as unknown,
  };
});

vi.mock("@dotli/ui/network-monitor", () => ({
  subscribeNetwork: (l: () => void) => {
    monitor.listeners.add(l);
    return () => monitor.listeners.delete(l);
  },
  getNetworkStatus: () => monitor.status,
  getTransfer: () => monitor.transfer,
}));

describe("network store", () => {
  afterEach(() => {
    resetStores();
    monitor.listeners.clear();
  });

  it("As the chains popover, the store mirrors the monitor on every change after start", async () => {
    // Given
    const { getNetworkState, startNetworkStore } = await import(
      "@dotli/ui/state/network"
    );
    const stop = startNetworkStore();
    monitor.status = [{ role: "relay", label: "Relay" }];

    // When
    for (const l of monitor.listeners) {
      l();
    }

    // Then
    expect(getNetworkState().chains).toEqual([{ role: "relay", label: "Relay" }]);
    stop();
    expect(monitor.listeners.size).toBe(0);
  });

  it("As the host, the store does nothing until started", async () => {
    // Given
    const { getNetworkState } = await import("@dotli/ui/state/network");

    // Then
    expect(getNetworkState().chains).toEqual([]);
    expect(monitor.listeners.size).toBe(0);
  });
});
```

Create `packages/ui/tests/state/settings.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { getSettingsState, initSettingsStore } from "@dotli/ui/state/settings";
import { getBackend, getCacheSettings } from "@dotli/config/mode";
import { getEnabledNetworks, getNetwork } from "@dotli/config/network";
import { resetStores } from "../helpers/solid";

describe("settings store", () => {
  afterEach(() => {
    resetStores();
    localStorage.clear();
  });

  it("As the prerendered shell, the settings store is empty until the host seeds it", () => {
    expect(getSettingsState()).toBeNull();
  });

  it("As the settings popover, initSettingsStore snapshots the config getters", () => {
    // When
    initSettingsStore();

    // Then
    expect(getSettingsState()).toEqual({
      backend: getBackend(),
      cache: getCacheSettings(),
      network: getNetwork(),
      enabledNetworks: getEnabledNetworks(),
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run --cwd packages/ui vitest run tests/state/network.test.ts tests/state/settings.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `packages/ui/src/state/network.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getNetworkStatus,
  getTransfer,
  subscribeNetwork,
  type ChainStatus,
} from "../network-monitor";
import { createSyncStore } from "./create-store";

export interface NetworkState {
  chains: ChainStatus[];
  transfer: ReturnType<typeof getTransfer>;
}

const network = createSyncStore<NetworkState>({
  chains: [],
  transfer: { bytesPerSecond: null, fetched: null, total: null },
});

export const networkState = network.read;
export const getNetworkState = network.get;

/**
 * Mirror the network monitor into the store. Not called by production code
 * until the chains popover becomes a component (sub-project 4); the popover
 * starts it while open, as it does with `subscribeNetwork` today.
 */
export function startNetworkStore(): () => void {
  const sync = (): void => {
    network.set({ chains: getNetworkStatus(), transfer: getTransfer() });
  };
  sync();
  return subscribeNetwork(sync);
}
```

Before writing it, check the transfer shape matches: `grep -n "transfer = {" packages/ui/src/network-monitor.ts` must show `{ bytesPerSecond: null, fetched: null, total: null }`. If the field names differ, use the monitor's exact initial value. If `ChainStatus` is not exported, export it from `network-monitor.ts` (`export interface ChainStatus`). It is already imported by `topbar.ts` as `type ChainStatus`, so it is exported.

Note: the second network test expects `chains` to be `[]` before start. `startNetworkStore()` calls `sync()` immediately, which is intended; the first test sets `monitor.status` after start and triggers a listener.

Create `packages/ui/src/state/settings.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getBackend,
  getCacheSettings,
  type Backend,
  type CacheSettings,
} from "@dotli/config/mode";
import {
  getEnabledNetworks,
  getNetwork,
  type Network,
} from "@dotli/config/network";
import { createSyncStore } from "./create-store";

export interface SettingsState {
  backend: Backend;
  cache: CacheSettings;
  network: Network;
  enabledNetworks: Network[];
}

// Null until the host seeds it, so nothing reads localStorage at import time
// or during build-time rendering.
const settings = createSyncStore<SettingsState | null>(null);

export const settingsState = settings.read;
export const getSettingsState = settings.get;

/**
 * Snapshot the persisted settings. Changes go through the settings popover's
 * apply-and-reload path, so one snapshot per page load is enough.
 */
export function initSettingsStore(): void {
  settings.set({
    backend: getBackend(),
    cache: getCacheSettings(),
    network: getNetwork(),
    enabledNetworks: getEnabledNetworks(),
  });
}
```

- [ ] **Step 4: Seed settings at host boot**

In `apps/host/src/main.ts`, add `import { initSettingsStore } from "@dotli/ui/state/settings";` and call `initSettingsStore();` on the line after the `applyUrlSettings(...)` call inside `main()` (find it with `grep -n "applyUrlSettings" apps/host/src/main.ts`). URL settings must be applied first so the snapshot includes them.

- [ ] **Step 5: Run tests**

Run: `bun run --cwd packages/ui vitest run tests/state/network.test.ts tests/state/settings.test.ts tests/network-monitor.test.ts`
Expected: PASS.
Run: `bun run --cwd apps/host test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run typecheck && bun run lint
git add packages/ui/src/state/network.ts packages/ui/src/state/settings.ts apps/host/src/main.ts packages/ui/tests/state/network.test.ts packages/ui/tests/state/settings.test.ts
git commit -m "feat(ui): add network and settings stores"
```

---

### Task 10: Mount helpers (`mountRoot`, `ensureOverlayRoot`)

**Files:**
- Create: `packages/ui/src/mount/root.ts`, `packages/ui/src/mount/overlay-root.ts`
- Test: `packages/ui/tests/mount/root.test.tsx`, `packages/ui/tests/mount/overlay-root.test.ts`

**Interfaces:**
- Consumes: `settle()` (Task 2); `captureException(err: unknown, tags?: Record<string, string>): void` from `@dotli/metrics/sentry`.
- Produces:
  ```ts
  // mount/root.ts
  export function mountRoot(name: string, container: HTMLElement, view: () => JSX.Element): () => void;
  export function disposeRoot(name: string): void;  // no-op if not mounted
  // mount/overlay-root.ts
  export function ensureOverlayRoot(): HTMLElement;  // <div id="overlay-root">, last child of body
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/tests/mount/root.test.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import { settle } from "../helpers/solid";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

function container(id: string): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  document.body.appendChild(el);
  return el;
}

describe("mountRoot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sentry.captureException.mockClear();
  });

  it("As a sub-project, a mounted root renders and its disposer empties the container", async () => {
    // Given
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const el = container("a");

    // When
    const dispose = mountRoot("a", el, () => <p class="hello">hi</p>);
    await settle();

    // Then
    expect(el.querySelector(".hello")?.textContent).toBe("hi");
    dispose();
    expect(el.childNodes.length).toBe(0);
  });

  it("As activateHost, disposeRoot by name unmounts a root and is a no-op for unknown names", async () => {
    // Given
    const { disposeRoot, mountRoot } = await import("@dotli/ui/mount/root");
    const el = container("b");
    mountRoot("b", el, () => <span>b</span>);
    await settle();

    // When
    disposeRoot("b");
    disposeRoot("never-mounted");

    // Then
    expect(el.childNodes.length).toBe(0);
  });

  it("As a user, a root whose view throws is reported to Sentry and does not break sibling roots", async () => {
    // Given
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const good = container("good");
    const bad = container("bad");
    mountRoot("good", good, () => <span class="ok">ok</span>);

    // When
    mountRoot("bad", bad, () => {
      throw new Error("boom");
    });
    await settle();

    // Then
    expect(good.querySelector(".ok")?.textContent).toBe("ok");
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
      { root: "bad" },
    );
    expect(document.body.contains(good)).toBe(true);
  });

  it("As a sub-project, mounting the same name twice disposes the first root", async () => {
    // Given
    const { mountRoot } = await import("@dotli/ui/mount/root");
    const first = container("first");
    const second = container("second");
    mountRoot("dup", first, () => <span>1</span>);

    // When
    mountRoot("dup", second, () => <span>2</span>);
    await settle();

    // Then
    expect(first.childNodes.length).toBe(0);
    expect(second.textContent).toBe("2");
  });
});
```

Create `packages/ui/tests/mount/overlay-root.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from "vitest";
import { ensureOverlayRoot } from "@dotli/ui/mount/overlay-root";

describe("ensureOverlayRoot", () => {
  beforeEach(() => {
    document.body.innerHTML = "<main></main>";
  });

  it("As the overlays root, the container is created once as the last child of body", () => {
    // When
    const first = ensureOverlayRoot();
    const second = ensureOverlayRoot();

    // Then
    expect(first).toBe(second);
    expect(first.id).toBe("overlay-root");
    expect(document.body.lastElementChild).toBe(first);
    expect(document.querySelectorAll("#overlay-root").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun run --cwd packages/ui vitest run tests/mount`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `packages/ui/src/mount/root.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createComponent, Errored } from "solid-js";
import { render, type JSX } from "@solidjs/web";
import { captureException } from "@dotli/metrics/sentry";

const roots = new Map<string, () => void>();

/**
 * Render `view` into `container` as the named root. A throwing view is caught
 * by an error boundary, reported to Sentry with `{ root: name }`, and renders
 * nothing, so other roots and the page keep working. Mounting a name that is
 * already mounted disposes the old root first.
 */
export function mountRoot(
  name: string,
  container: HTMLElement,
  view: () => JSX.Element,
): () => void {
  disposeRoot(name);
  const dispose = render(
    () =>
      createComponent(Errored, {
        fallback: (err: () => unknown) => {
          captureException(err(), { root: name });
          return null;
        },
        get children() {
          return view();
        },
      }),
    container,
  );
  const disposeThis = (): void => {
    if (roots.get(name) === disposeThis) {
      roots.delete(name);
    }
    dispose();
  };
  roots.set(name, disposeThis);
  return disposeThis;
}

/** Unmount the named root. No-op if it is not mounted. */
export function disposeRoot(name: string): void {
  roots.get(name)?.();
}
```

`root.ts` is plain `.ts` (no JSX), so it uses `createComponent` rather than `<Errored>`. If `createComponent` is not exported from `solid-js` in rc.9, rename the file to `root.tsx` and write the view as:

```tsx
  const dispose = render(
    () => (
      <Errored
        fallback={(err) => {
          captureException(err(), { root: name });
          return null;
        }}
      >
        {view()}
      </Errored>
    ),
    container,
  );
```

Keep the import path `@dotli/ui/mount/root` either way (Vite resolves `.tsx`).

Create `packages/ui/src/mount/overlay-root.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const OVERLAY_ROOT_ID = "overlay-root";

/**
 * The container for toasts and modals. Created on first use as the last child
 * of `body`, so overlays stack above the shell and `#app`.
 */
export function ensureOverlayRoot(): HTMLElement {
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing !== null) {
    return existing;
  }
  const el = document.createElement("div");
  el.id = OVERLAY_ROOT_ID;
  document.body.appendChild(el);
  return el;
}
```

- [ ] **Step 4: Run tests**

Run: `bun run --cwd packages/ui vitest run tests/mount`
Expected: PASS (5 tests). If the throwing-view test fails because Solid rethrows from `render` in dev instead of routing to `Errored`, the boundary is placed wrong: `view()` must be called inside the `children` getter (as written), not before `createComponent`.

- [ ] **Step 5: Commit**

```bash
bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint
git add packages/ui/src/mount packages/ui/tests/mount
git commit -m "feat(ui): add mountRoot with error boundary and ensureOverlayRoot"
```

---

### Task 11: Delete the unused alias permission modal

**Files:**
- Delete: `packages/ui/src/alias-permission-modal.ts`

**Interfaces:**
- Consumes: nothing. Produces: nothing.

- [ ] **Step 1: Prove it is unused**

```bash
grep -rn "alias-permission-modal\|showAliasPermissionModal" apps packages docs --exclude-dir=node_modules --exclude-dir=dist
```

Expected: matches only inside `packages/ui/src/alias-permission-modal.ts` itself (and the specs/plan in `docs/superpowers`). If anything else imports it, stop and report; do not delete.

The modal uses the shared `signing-*` classes that `UserConfirmation.ts` also uses, so no CSS is removed.

- [ ] **Step 2: Delete, then build and test**

```bash
git rm packages/ui/src/alias-permission-modal.ts
bun run typecheck && bun run --cwd packages/ui test
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(ui): delete unused alias permission modal"
```

---

### Task 12: Verify the whole sub-project and record the after numbers

**Files:**
- Modify: `docs/perf/solid-migration-baseline.md`

**Interfaces:**
- Consumes: everything above. Produces: the final measurements.

- [ ] **Step 1: Full checks**

```bash
bun run format:check && bun run typecheck && bun run lint && bun run test
```

Expected: all green. If `format:check` fails on new files, run `bun run format` and commit the result with the relevant task's scope.

- [ ] **Step 2: Production build**

```bash
VITE_NETWORKS=paseo-next-v2,previewnet bun run build
```

Expected: succeeds.

- [ ] **Step 3: Confirm what shipped (Review Focus 5)**

The builds emit hidden sourcemaps (`build.sourcemap: "hidden"`), whose `sources` arrays list every module in each chunk. That is reliable where grepping minified code is not:

```bash
# The DOM runtime and the probe must not be in any host or sandbox chunk yet.
grep -l '@solidjs/web' apps/host/dist/assets/*.js.map apps/sandbox/dist/assets/*.js.map || echo "web runtime: absent"
grep -l 'SolidProbe' apps/host/dist/assets/*.js.map apps/sandbox/dist/assets/*.js.map || echo "probe: absent"
# The reactive core is expected, in the host chunk that holds the stores.
grep -l '@solidjs/signals' apps/host/dist/assets/*.js.map
```

Expected: `web runtime: absent`, `probe: absent`, and the last command lists at least one host map. If `@solidjs/web` shows up, something imported it into app code (most likely `mount/root.ts`); find the importer with `grep -rn "mount/root\|@solidjs/web" apps/*/src packages/*/src` and remove it.

- [ ] **Step 4: Functional Playwright suite**

```bash
bun run --cwd apps/host test:functional
```

Expected: PASS, no test edited. If the suite needs `bun preview` running, start it in another terminal first (`bun preview`) and follow the suite's README / config for the base URL.

- [ ] **Step 5: Manual no-change check**

Run `bun preview`, open the printed URL, and confirm each of these behaves exactly as on `main`:
- landing page renders; typing a name shows the `.dot` suffix; recent pills appear;
- opening a `.dot` name shows the loading screen, then the product;
- the login button opens the QR modal; closing it works;
- theme toggle switches light/dark;
- going offline (DevTools → Network → Offline) shows the offline banner;
- a toast appears (e.g. Settings → switch backend to trigger the shared-worker fallback toast, or any action that toasts).

- [ ] **Step 6: Measure after numbers**

Repeat Task 1 Steps 3-4 into `/tmp/solid-after-sizes.tsv` and a fresh perf run:

```bash
for f in apps/host/dist/assets/*.js apps/sandbox/dist/assets/*.js; do
  printf '%s\t%d\t%d\n' "$f" "$(wc -c <"$f")" "$(gzip -c "$f" | wc -c)"
done | sort > /tmp/solid-after-sizes.tsv
bun run --cwd apps/host test:perf
bun run --cwd apps/host test:perf:compare
```

- [ ] **Step 7: Append results and check the gates**

Append to `docs/perf/solid-migration-baseline.md`:

````markdown
## After sub-project 0

### Chunk sizes (bytes)

| Chunk | Raw | Gzip | Δ gzip vs before |
|---|---|---|---|
<one row per chunk from /tmp/solid-after-sizes.tsv>

### Cold start

| Mark pair | Before median ms | After median ms | Δ % |
|---|---|---|---|
| dotli:main:start → dotli:main:end | <before> | <after> | <pct> |

Gates: host eager `index-*.js` Δ gzip < 3 KB → <pass/fail>; cold start Δ within 5% → <pass/fail>.
````

Fill every `<…>`. If a gate fails, do not merge: report the numbers and the largest contributing chunk.

- [ ] **Step 8: Commit**

```bash
git add docs/perf/solid-migration-baseline.md
git commit -m "docs(perf): record bundle and cold-start numbers after Solid foundation"
```
