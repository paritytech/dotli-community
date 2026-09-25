# Solid v2 SP1 — modals and toasts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the permission, preimage, password and confirmation dialogs and the toast stack as Solid components in one lazily loaded `overlays` root, with every public function, promise result, markup class and button label unchanged.

**Architecture:** Two Solid-free stores (`state/modals.ts`, `state/toasts.ts`) hold what is on screen and all promise, abort and timer logic. `overlays/load.ts` (Solid-free) writes to the stores and lazily imports `components/overlays/mount.tsx`, which mounts `<ToastStack/>` and `<ModalOutlet/>` into `#overlay-root` via `mountRoot`. The existing modules become thin wrappers that build plain data and call the loader.

**Tech Stack:** Solid 2 RC (`solid-js`, `@solidjs/web` `2.0.0-rc.9`), `@solidjs/testing-library` `1.0.0-beta.3`, Vitest 5 + happy-dom, TypeScript 6 strict, Bun 1.3.13, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-solid-v2-sp1-overlays-design.md` (parent: `docs/superpowers/specs/2026-09-25-solid-v2-ui-migration-design.md`).

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push, never open a PR.
- **Solid-free files never import `solid-js`, `@solidjs/web`, anything under `packages/ui/src/components/`, or `packages/ui/src/mount/root.ts`.** Solid-free files in this plan: `state/modals.ts`, `state/toasts.ts`, `overlays/load.ts`, `notification.ts`, `permission-modal.ts`, `preimage-modal.ts`, `password-prompt.ts`, `host-callbacks/UserConfirmation.ts`. The only way to reach Solid code is the dynamic `import("../components/overlays/mount")` in `overlays/load.ts`.
- Public exports and signatures stay exactly as they are: `showPermissionRequestModal`, `PERMISSION_DESCRIPTIONS`, `PermissionPromptDecision`, `PermissionRequestModalOptions`, `showPreimageSubmitModal`, `showPasswordPrompt`, `createUserConfirmationAdapters`, `showNotification`, `NotificationParams`, `NOTIFICATION_DISMISS_MS`.
- Markup classes, ids and visible labels are a frozen contract: `.signing-modal-backdrop > .signing-modal`, `.permission-modal-icon`, `h2`, `.signing-fields`, `.signing-field`, `.signing-field-warning`, `.signing-field-label`, `.signing-field-value`, `.mono`, `.permission-modal-notice`, `.password-prompt-error`, `input.password-prompt-input`, `.signing-modal-footer`, `.signing-btn-cancel`, `.signing-btn-secondary`, `.signing-btn-sign`; `.notif-stack`, `.expanded`, `.single`, `.notif-cards`, `.notif-close-all`, `.notif-card[data-id]`, `.notif-enter`, `.notif-leave`, `.notif-hidden-card`, `.notif-icon`, `.notif-text`, `.notif-title`, `.notif-body`, `.notif-action`, `.notif-card-close`; `aria-label` "Dismiss" and "Dismiss all". Button labels: "Deny", "Allow", "Always allow", "Allow once", "Sign", "Cancel", "Unlock", and the per-review copy in `UserConfirmation.ts`.
- `ERRORS` values are unchanged; `blocking-modal-queue.ts`, `PromptPermission.ts`, `PushNotification.ts`, `scheduled-notifications.ts` and all CSS files are not modified.
- Stores follow `state/create-store.ts`: exported as `ReadableStore<T>`; listeners must not call setters.
- Component tests live in `packages/ui/tests/components/overlays/`, use `renderComponent` / `settle` from `tests/helpers/solid.ts`, and call `settle()` after any event or store write before asserting.
- Test names follow the repo style ("As a dotli user, …" / "As a dotli integrator, …") with `// Given / // When / // Then` comments.
- Every commit passes `bun run typecheck`, `bun run lint`, `bun run test`. `bun run format:check` repo-wide may flag only gitignored scratch under `.superpowers/`; check changed files with `bunx prettier --check <files>`.
- Solid 2 RC JSX idioms used in this plan (verified against `node_modules/.bun/solid-js@2.0.0-rc.9`): `class` accepts a string or an array such as `["a", { b: cond }]`; `createEffect(compute, effect)` where `effect` may return a cleanup; `onSettled(fn)` for one-time post-render DOM work; `createMemo((prev) => …)`; `<For each keyed={(item) => key}>` passes accessors to its child; `<Show when keyed>{(value) => …}</Show>` passes the raw value. If the RC's JSX types reject `innerHTML` on an element, set it through a `ref` callback (`ref={(el) => { el.innerHTML = svg; }}`) and say so in the report.
- If `eslint-plugin-solid` flags a deliberate one-time read of a prop (for example the keyed `entry` in `SigningDialog`), keep the read and add `// eslint-disable-next-line solid/reactivity -- <reason>` rather than restructuring.

## Review Focus

1. A toast dismissed while it is hidden beyond the three visible cards must disappear at once; `animationend` never fires on `display: none`, so waiting for it would leave the stack up forever. Pinned in Task 4.
2. An abort that fires while the overlay chunk is still loading (entry in the store, nothing rendered yet) must reject with `AbortError`, remove the entry, and never render that dialog later. Pinned in Task 1 and Task 6.
3. A toast `onDismiss` callback that throws must not leave the toast stuck on screen; the toast still leaves and the error goes to Sentry. Pinned in Task 2.
4. A toast pushed while the tab is hidden must not start its countdown until the tab becomes visible, and then last its full duration. Pinned in Task 2.
5. A toast pushed before the overlay chunk has mounted (the host's boot-time banners) must appear once it mounts. Pinned in Task 5.

---

### Task 1: Modal store

**Files:**
- Create: `packages/ui/src/state/modals.ts`
- Test: `packages/ui/tests/state/modals.test.ts`

**Interfaces:**
- Consumes: `createSyncStore`, `ReadableStore` from `packages/ui/src/state/create-store.ts`; `blockingModalAbortError(reason?: unknown): DOMException` from `packages/ui/src/blocking-modal-queue.ts`.
- Produces (exact):
  ```ts
  export type ModalButtonVariant = "cancel" | "secondary" | "primary";
  export interface ModalField { label: string; value: string; mono?: boolean; warning?: boolean }
  export interface ModalButton<R extends string> { label: string; variant: ModalButtonVariant; result: R }
  export interface ModalPasswordInput { kind: "password"; placeholder: string; hint?: string; error?: string }
  export interface ModalView<R extends string> {
    title: string; icon?: string; fields: ModalField[]; notice?: string; input?: ModalPasswordInput;
    buttons: ModalButton<R>[]; dismissOnBackdrop: boolean; dismissResult?: R; fallbackResult: R;
  }
  export interface ModalOutcome<R extends string> { result: R; value?: string }
  export interface ModalEntry { id: number; view: ModalView<string> }
  export const modalsStore: ReadableStore<readonly ModalEntry[]>;
  export function openModal<R extends string>(view: ModalView<R>, signal?: AbortSignal): Promise<ModalOutcome<R>>;
  export function settleModal(id: number, result: string, value?: string): void;
  export function failAllModals(): void;
  export function resetModalsForTests(): void;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/ui/tests/state/modals.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  failAllModals,
  modalsStore,
  openModal,
  resetModalsForTests,
  settleModal,
  type ModalView,
} from "@dotli/ui/state/modals";

type Choice = "yes" | "no" | "dismissed";

function view(title: string): ModalView<Choice> {
  return {
    title,
    fields: [],
    buttons: [
      { label: "No", variant: "cancel", result: "no" },
      { label: "Yes", variant: "primary", result: "yes" },
    ],
    dismissOnBackdrop: true,
    dismissResult: "dismissed",
    fallbackResult: "dismissed",
  };
}

afterEach(() => {
  resetModalsForTests();
});

describe("modal store", () => {
  it("As a dotli integrator, an opened modal is queued in order and resolves with the chosen result", async () => {
    // Given
    const first = openModal(view("First"));
    const second = openModal(view("Second"));
    const [a, b] = modalsStore.get();

    // Then
    expect(modalsStore.get().map((e) => e.view.title)).toEqual([
      "First",
      "Second",
    ]);

    // When
    settleModal(a.id, "yes");

    // Then
    await expect(first).resolves.toEqual({ result: "yes" });
    expect(modalsStore.get().map((e) => e.id)).toEqual([b.id]);

    // When
    settleModal(b.id, "no", "typed");

    // Then
    await expect(second).resolves.toEqual({ result: "no", value: "typed" });
    expect(modalsStore.get()).toEqual([]);
  });

  it("As a dotli integrator, a modal settles only once", async () => {
    // Given
    const outcome = openModal(view("Once"));
    const [entry] = modalsStore.get();

    // When
    settleModal(entry.id, "yes");
    settleModal(entry.id, "no");
    failAllModals();

    // Then
    await expect(outcome).resolves.toEqual({ result: "yes" });
  });

  it("As a dotli integrator, an already aborted signal rejects without queueing anything", async () => {
    // Given
    const controller = new AbortController();
    controller.abort("gone");

    // When
    const outcome = openModal(view("Aborted"), controller.signal);

    // Then
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
    expect(modalsStore.get()).toEqual([]);
  });

  it("As a dotli integrator, aborting an open modal removes it and rejects with AbortError", async () => {
    // Given
    const controller = new AbortController();
    const outcome = openModal(view("Open"), controller.signal);

    // When
    controller.abort();

    // Then
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
    expect(modalsStore.get()).toEqual([]);
  });

  it("As a dotli user, when the overlays cannot render every open modal settles with its fallback result", async () => {
    // Given
    const first = openModal(view("First"));
    const second = openModal({ ...view("Second"), fallbackResult: "no" });

    // When
    failAllModals();

    // Then
    await expect(first).resolves.toEqual({ result: "dismissed" });
    await expect(second).resolves.toEqual({ result: "no" });
    expect(modalsStore.get()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/state/modals.test.ts`
Expected: FAIL, cannot resolve `@dotli/ui/state/modals`.

- [ ] **Step 3: Write the store**

`packages/ui/src/state/modals.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The dialogs waiting to be shown, as plain data. The overlays root renders
// the first entry; everything that decides how a dialog settles (buttons,
// dismissal, abort, fallback) lives here, outside Solid.

import { blockingModalAbortError } from "../blocking-modal-queue";
import { createSyncStore, type ReadableStore } from "./create-store";

export type ModalButtonVariant = "cancel" | "secondary" | "primary";

export interface ModalField {
  label: string;
  value: string;
  mono?: boolean;
  warning?: boolean;
}

export interface ModalButton<R extends string> {
  label: string;
  variant: ModalButtonVariant;
  result: R;
}

export interface ModalPasswordInput {
  kind: "password";
  placeholder: string;
  hint?: string;
  error?: string;
}

export interface ModalView<R extends string> {
  title: string;
  /** SVG markup, rendered in `.permission-modal-icon`. */
  icon?: string;
  fields: ModalField[];
  notice?: string;
  input?: ModalPasswordInput;
  /** Display order. */
  buttons: ModalButton<R>[];
  dismissOnBackdrop: boolean;
  /** Result of a backdrop click or Escape. Required when `dismissOnBackdrop`. */
  dismissResult?: R;
  /** Result when the overlays cannot render at all. */
  fallbackResult: R;
}

export interface ModalOutcome<R extends string> {
  result: R;
  /** The password input's value, for views with an input. */
  value?: string;
}

export interface ModalEntry {
  id: number;
  view: ModalView<string>;
}

interface Pending {
  resolve: (outcome: ModalOutcome<string>) => void;
  fallbackResult: string;
  detach: () => void;
}

const modals = createSyncStore<readonly ModalEntry[]>([]);
export const modalsStore: ReadableStore<readonly ModalEntry[]> = modals;

const pending = new Map<number, Pending>();
let nextId = 0;

function take(id: number): Pending | undefined {
  const entry = pending.get(id);
  if (entry === undefined) {
    return undefined;
  }
  pending.delete(id);
  entry.detach();
  modals.set(modals.get().filter((e) => e.id !== id));
  return entry;
}

/**
 * Queue a dialog. Resolves with the chosen result once a button, a dismissal
 * or the fallback decides it; rejects with an AbortError when `signal` fires.
 */
export function openModal<R extends string>(
  view: ModalView<R>,
  signal?: AbortSignal,
): Promise<ModalOutcome<R>> {
  if (signal?.aborted === true) {
    return Promise.reject(blockingModalAbortError(signal.reason));
  }
  const id = nextId++;
  return new Promise<ModalOutcome<R>>((resolve, reject) => {
    const onAbort = (): void => {
      if (take(id) !== undefined) {
        reject(blockingModalAbortError(signal?.reason));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve: resolve as (outcome: ModalOutcome<string>) => void,
      fallbackResult: view.fallbackResult,
      detach: () => {
        signal?.removeEventListener("abort", onAbort);
      },
    });
    modals.set([...modals.get(), { id, view }]);
  });
}

/** Settle one dialog. Ignored if it has already settled. */
export function settleModal(id: number, result: string, value?: string): void {
  take(id)?.resolve(value === undefined ? { result } : { result, value });
}

/** Settle every open dialog with its fallback result. */
export function failAllModals(): void {
  for (const id of [...pending.keys()]) {
    const entry = take(id);
    entry?.resolve({ result: entry.fallbackResult });
  }
}

/** Forget every dialog without settling it. Tests only. */
export function resetModalsForTests(): void {
  for (const entry of pending.values()) {
    entry.detach();
  }
  pending.clear();
  nextId = 0;
  modals.set([]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/state/modals.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/state/modals.ts packages/ui/tests/state/modals.test.ts
git commit -m "feat(ui): add Solid-free modal store"
```

---

### Task 2: Toast store

**Files:**
- Create: `packages/ui/src/state/toasts.ts`
- Test: `packages/ui/tests/state/toasts.test.ts`

**Interfaces:**
- Consumes: `createSyncStore`, `ReadableStore` from `state/create-store.ts`; `captureException` from `@dotli/metrics/sentry`.
- Produces (exact):
  ```ts
  export interface ToastAction { label: string; onClick: () => void }
  export interface ToastInput {
    text: string; label: string; deeplink?: string; icon: string; iconBackground?: string;
    dismissMs: number; onDismiss?: () => void; action?: ToastAction;
  }
  export interface ToastEntry {
    id: number; text: string; label: string; deeplink?: string; icon: string;
    iconBackground?: string; action?: ToastAction; leaving: boolean;
  }
  export interface ToastsState { items: readonly ToastEntry[]; expanded: boolean }
  export const toastsStore: ReadableStore<ToastsState>;
  export function pushToast(input: ToastInput): number;
  export function dismissToast(id: number): void;
  export function removeToast(id: number): void;
  export function dismissAllToasts(): void;
  export function setToastsExpanded(expanded: boolean): void;
  export function clearToasts(): void;
  export function resetToastsForTests(): void;
  ```
- Behaviour copied from today's `notification.ts`: a timer runs only while `remaining > 0`, the entry is not leaving, the stack is not expanded and `document.visibilityState === "visible"`; pausing keeps the remaining time; `dismissMs: 0` never starts a timer. `removeToast` collapses the stack when one or zero entries remain (and resumes timers if it was expanded).

- [ ] **Step 1: Write the failing tests**

`packages/ui/tests/state/toasts.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

import {
  clearToasts,
  dismissAllToasts,
  dismissToast,
  pushToast,
  removeToast,
  resetToastsForTests,
  setToastsExpanded,
  toastsStore,
  type ToastInput,
} from "@dotli/ui/state/toasts";

function input(overrides: Partial<ToastInput> = {}): ToastInput {
  return { text: "Body", label: "Title", icon: "<svg></svg>", dismissMs: 1000, ...overrides };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function leaving(): boolean[] {
  return toastsStore.get().items.map((t) => t.leaving);
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});

afterEach(() => {
  resetToastsForTests();
  vi.useRealTimers();
  sentry.captureException.mockReset();
});

describe("toast store", () => {
  it("As a dotli user, a toast leaves after its duration and calls onDismiss once", () => {
    // Given
    const onDismiss = vi.fn();
    pushToast(input({ onDismiss }));

    // When
    vi.advanceTimersByTime(999);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(leaving()).toEqual([true]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("As a dotli user, a persistent toast stays until I close it", () => {
    // Given
    const id = pushToast(input({ dismissMs: 0 }));

    // When
    vi.advanceTimersByTime(60_000);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    dismissToast(id);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it("As a dotli user, the countdown pauses while the tab is hidden and resumes from what was left", () => {
    // Given
    pushToast(input());
    vi.advanceTimersByTime(600);

    // When
    setVisibility("hidden");
    vi.advanceTimersByTime(5000);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    setVisibility("visible");
    vi.advanceTimersByTime(399);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it("As a dotli user, a toast shown while the tab is hidden gets its full time once I come back", () => {
    // Given
    setVisibility("hidden");
    pushToast(input());
    vi.advanceTimersByTime(10_000);

    // When
    setVisibility("visible");
    vi.advanceTimersByTime(999);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it("As a dotli user, an expanded stack pauses every countdown until it collapses", () => {
    // Given
    pushToast(input());
    pushToast(input());

    // When
    setToastsExpanded(true);
    vi.advanceTimersByTime(5000);

    // Then
    expect(toastsStore.get().expanded).toBe(true);
    expect(leaving()).toEqual([false, false]);

    // When
    setToastsExpanded(false);
    vi.advanceTimersByTime(1000);

    // Then
    expect(leaving()).toEqual([true, true]);
  });

  it("As a dotli user, the stack collapses and countdowns resume when only one toast is left", () => {
    // Given
    const first = pushToast(input({ dismissMs: 0 }));
    pushToast(input());
    setToastsExpanded(true);

    // When
    dismissToast(first);
    removeToast(first);

    // Then
    expect(toastsStore.get().expanded).toBe(false);

    // When
    vi.advanceTimersByTime(1000);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it("As a dotli user, dismiss all marks every toast as leaving and calls each onDismiss once", () => {
    // Given
    const a = vi.fn();
    const b = vi.fn();
    pushToast(input({ onDismiss: a }));
    pushToast(input({ onDismiss: b, dismissMs: 0 }));

    // When
    dismissAllToasts();
    vi.advanceTimersByTime(5000);

    // Then
    expect(leaving()).toEqual([true, true]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("As a dotli user, a toast whose onDismiss throws still leaves, and the error is reported", () => {
    // Given
    const error = new Error("callback broke");
    const id = pushToast(
      input({
        onDismiss: () => {
          throw error;
        },
      }),
    );

    // When
    dismissToast(id);

    // Then
    expect(leaving()).toEqual([true]);
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      kind: "toast_on_dismiss_error",
    });
  });

  it("As a dotli integrator, removing the last toast empties the store and clearToasts drops everything without callbacks", () => {
    // Given
    const onDismiss = vi.fn();
    const id = pushToast(input());
    pushToast(input({ onDismiss }));

    // When
    removeToast(id);
    clearToasts();
    vi.advanceTimersByTime(5000);

    // Then
    expect(toastsStore.get()).toEqual({ items: [], expanded: false });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/state/toasts.test.ts`
Expected: FAIL, cannot resolve `@dotli/ui/state/toasts`.

- [ ] **Step 3: Write the store**

`packages/ui/src/state/toasts.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The toasts on screen, as plain data, plus their auto-dismiss timers. A
// countdown pauses while the tab is hidden or the stack is expanded and
// resumes from what was left. The overlays root renders this store.

import { captureException } from "@dotli/metrics/sentry";
import { createSyncStore, type ReadableStore } from "./create-store";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  text: string;
  label: string;
  deeplink?: string;
  icon: string;
  iconBackground?: string;
  /** 0 = persistent. */
  dismissMs: number;
  onDismiss?: () => void;
  action?: ToastAction;
}

export interface ToastEntry {
  id: number;
  text: string;
  label: string;
  deeplink?: string;
  icon: string;
  iconBackground?: string;
  action?: ToastAction;
  leaving: boolean;
}

export interface ToastsState {
  /** Newest last. */
  items: readonly ToastEntry[];
  expanded: boolean;
}

interface Timer {
  remaining: number;
  startedAt: number;
  handle: ReturnType<typeof setTimeout> | undefined;
  onDismiss: (() => void) | undefined;
}

const INITIAL: ToastsState = { items: [], expanded: false };
const toasts = createSyncStore<ToastsState>(INITIAL);
export const toastsStore: ReadableStore<ToastsState> = toasts;

const timers = new Map<number, Timer>();
let nextId = 0;
let visibilityBound = false;

function shouldPause(): boolean {
  return toasts.get().expanded || document.visibilityState !== "visible";
}

function start(id: number): void {
  const timer = timers.get(id);
  if (
    timer === undefined ||
    timer.remaining <= 0 ||
    timer.handle !== undefined ||
    shouldPause()
  ) {
    return;
  }
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => {
    timer.handle = undefined;
    dismissToast(id);
  }, timer.remaining);
}

function pause(id: number): void {
  const timer = timers.get(id);
  if (timer?.handle === undefined) {
    return;
  }
  clearTimeout(timer.handle);
  timer.handle = undefined;
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
}

function pauseAll(): void {
  for (const id of timers.keys()) {
    pause(id);
  }
}

function resumeAll(): void {
  if (shouldPause()) {
    return;
  }
  for (const id of timers.keys()) {
    start(id);
  }
}

function bindVisibility(): void {
  if (visibilityBound) {
    return;
  }
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      resumeAll();
    } else {
      pauseAll();
    }
  });
}

/** Stop a toast's countdown for good and run its onDismiss. */
function finishTimer(id: number): void {
  const timer = timers.get(id);
  pause(id);
  timers.delete(id);
  try {
    timer?.onDismiss?.();
  } catch (err) {
    captureException(err, { kind: "toast_on_dismiss_error" });
  }
}

export function pushToast(input: ToastInput): number {
  bindVisibility();
  const id = nextId++;
  timers.set(id, {
    remaining: input.dismissMs,
    startedAt: 0,
    handle: undefined,
    onDismiss: input.onDismiss,
  });
  const entry: ToastEntry = {
    id,
    text: input.text,
    label: input.label,
    icon: input.icon,
    leaving: false,
  };
  if (input.deeplink !== undefined) {
    entry.deeplink = input.deeplink;
  }
  if (input.iconBackground !== undefined) {
    entry.iconBackground = input.iconBackground;
  }
  if (input.action !== undefined) {
    entry.action = input.action;
  }
  const state = toasts.get();
  toasts.set({ ...state, items: [...state.items, entry] });
  start(id);
  return id;
}

/** Start a toast's exit: run onDismiss and mark it leaving. */
export function dismissToast(id: number): void {
  const state = toasts.get();
  const entry = state.items.find((t) => t.id === id);
  if (entry === undefined || entry.leaving) {
    return;
  }
  finishTimer(id);
  toasts.set({
    ...state,
    items: state.items.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
  });
}

/** Drop a toast once its exit animation has finished. */
export function removeToast(id: number): void {
  const state = toasts.get();
  if (!state.items.some((t) => t.id === id)) {
    return;
  }
  timers.delete(id);
  const items = state.items.filter((t) => t.id !== id);
  const collapse = state.expanded && items.length <= 1;
  toasts.set({ items, expanded: collapse ? false : state.expanded });
  if (collapse) {
    resumeAll();
  }
}

export function dismissAllToasts(): void {
  const state = toasts.get();
  const active = state.items.filter((t) => !t.leaving);
  if (active.length === 0) {
    return;
  }
  pauseAll();
  for (const t of active) {
    finishTimer(t.id);
  }
  toasts.set({
    ...state,
    items: state.items.map((t) => (t.leaving ? t : { ...t, leaving: true })),
  });
}

export function setToastsExpanded(expanded: boolean): void {
  const state = toasts.get();
  if (state.expanded === expanded) {
    return;
  }
  toasts.set({ ...state, expanded });
  if (expanded) {
    pauseAll();
  } else {
    resumeAll();
  }
}

/** Drop every toast without running callbacks. Used when overlays cannot render. */
export function clearToasts(): void {
  pauseAll();
  timers.clear();
  toasts.set(INITIAL);
}

/** Tests only. */
export function resetToastsForTests(): void {
  clearToasts();
  nextId = 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/state/toasts.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/state/toasts.ts packages/ui/tests/state/toasts.test.ts
git commit -m "feat(ui): add Solid-free toast store with pausable timers"
```

---

### Task 3: Dialog components

**Files:**
- Create: `packages/ui/src/components/overlays/Dialog.tsx`
- Create: `packages/ui/src/components/overlays/SigningDialog.tsx`
- Create: `packages/ui/src/components/overlays/ModalOutlet.tsx`
- Test: `packages/ui/tests/components/overlays/dialog.test.tsx`
- Delete: `packages/ui/src/components/dev/SolidProbe.tsx`, `packages/ui/tests/components/solid-probe.test.tsx`

**Interfaces:**
- Consumes: `modalsStore`, `openModal`, `settleModal`, `resetModalsForTests`, `ModalEntry`, `ModalButtonVariant`, `ModalView` (Task 1); `useStore` from `components/use-store.ts`; `renderComponent`, `settle` from `tests/helpers/solid.ts`.
- Produces: `export function ModalOutlet(): JSX.Element` (renders the first `modalsStore` entry); `SigningDialog(props: { entry: ModalEntry }): JSX.Element`; `Dialog(props: DialogProps): JSX.Element` where
  ```ts
  interface DialogProps {
    titleId: string;
    initialFocus?: () => HTMLElement | undefined;
    onDismiss: () => void; // backdrop click and Escape
    children: JSX.Element;
  }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/ui/tests/components/overlays/dialog.test.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { ModalOutlet } from "@dotli/ui/components/overlays/ModalOutlet";
import {
  openModal,
  resetModalsForTests,
  type ModalView,
} from "@dotli/ui/state/modals";
import { renderComponent, settle } from "../../helpers/solid";

type Choice = "deny" | "allow" | "once" | "dismissed";

function permissionLike(overrides: Partial<ModalView<Choice>> = {}): ModalView<Choice> {
  return {
    title: "Permission Request",
    icon: '<svg data-testid="icon"></svg>',
    fields: [
      { label: "Application", value: "myapp.dot" },
      { label: "Call Data", value: "0x1234", mono: true },
      { label: "Warning", value: "Careful", warning: true },
    ],
    notice: "Granting this permission will reload the application.",
    buttons: [
      { label: "Deny", variant: "cancel", result: "deny" },
      { label: "Always allow", variant: "secondary", result: "allow" },
      { label: "Allow once", variant: "primary", result: "once" },
    ],
    dismissOnBackdrop: true,
    dismissResult: "dismissed",
    fallbackResult: "dismissed",
    ...overrides,
  };
}

function passwordView(error?: string): ModalView<"cancel" | "unlock"> {
  return {
    title: "Encrypted Content",
    fields: [],
    input: {
      kind: "password",
      placeholder: "Password",
      hint: "Enter the password to decrypt.",
      ...(error === undefined ? {} : { error }),
    },
    buttons: [
      { label: "Cancel", variant: "cancel", result: "cancel" },
      { label: "Unlock", variant: "primary", result: "unlock" },
    ],
    dismissOnBackdrop: false,
    fallbackResult: "cancel",
  };
}

async function mountOutlet(): Promise<void> {
  renderComponent(() => <ModalOutlet />);
  await settle();
}

afterEach(() => {
  resetModalsForTests();
  document.body.replaceChildren();
});

describe("signing dialog", () => {
  it("As a dotli user, a dialog shows today's markup, labels and dialog semantics", async () => {
    // Given
    void openModal(permissionLike());

    // When
    await mountOutlet();

    // Then
    const modal = document.querySelector<HTMLElement>(".signing-modal-backdrop > .signing-modal");
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute("role")).toBe("dialog");
    expect(modal?.getAttribute("aria-modal")).toBe("true");
    const title = modal?.querySelector("h2");
    expect(title?.textContent).toBe("Permission Request");
    expect(modal?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(modal?.querySelector(".permission-modal-icon svg")).not.toBeNull();
    expect(
      [...document.querySelectorAll(".signing-fields > .signing-field")].map((f) => f.className),
    ).toEqual(["signing-field", "signing-field", "signing-field signing-field-warning"]);
    expect(document.querySelector(".signing-field-value.mono")?.textContent).toBe("0x1234");
    expect(document.querySelector(".permission-modal-notice")?.textContent).toBe(
      "Granting this permission will reload the application.",
    );
    expect(
      [...document.querySelectorAll(".signing-modal-footer button")].map((b) => [b.textContent, b.className]),
    ).toEqual([
      ["Deny", "signing-btn-cancel"],
      ["Always allow", "signing-btn-secondary"],
      ["Allow once", "signing-btn-sign"],
    ]);
  });

  it("As a dotli user, clicking a button settles the dialog with that button's result and closes it", async () => {
    // Given
    const outcome = openModal(permissionLike());
    await mountOutlet();

    // When
    fireEvent.click(document.querySelector<HTMLButtonElement>(".signing-btn-secondary")!);
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: "allow" });
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
  });

  it("As a dotli user, the backdrop and Escape dismiss a dialog that allows it, and a click inside does not", async () => {
    // Given
    const first = openModal(permissionLike());
    const second = openModal(permissionLike({ title: "Second" }));
    await mountOutlet();

    // When
    fireEvent.click(document.querySelector<HTMLElement>(".signing-modal")!);
    await settle();

    // Then
    expect(document.querySelector("h2")?.textContent).toBe("Permission Request");

    // When
    fireEvent.click(document.querySelector<HTMLElement>(".signing-modal-backdrop")!);
    await settle();

    // Then
    await expect(first).resolves.toEqual({ result: "dismissed" });
    expect(document.querySelector("h2")?.textContent).toBe("Second");

    // When
    fireEvent.keyDown(document, { key: "Escape" });
    await settle();

    // Then
    await expect(second).resolves.toEqual({ result: "dismissed" });
  });

  it("As a dotli user, the backdrop and Escape do nothing on a dialog that must be answered", async () => {
    // Given
    let settled = false;
    void openModal(passwordView()).then(() => {
      settled = true;
    });
    await mountOutlet();

    // When
    fireEvent.click(document.querySelector<HTMLElement>(".signing-modal-backdrop")!);
    fireEvent.keyDown(document, { key: "Escape" });
    await settle();

    // Then
    expect(settled).toBe(false);
    expect(document.querySelector(".signing-modal-backdrop")).not.toBeNull();
  });

  it("As a dotli user, focus starts on the dialog, not on the approve button, and Tab stays inside", async () => {
    // Given
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    void openModal(permissionLike());

    // When
    await mountOutlet();

    // Then
    const modal = document.querySelector<HTMLElement>(".signing-modal")!;
    expect(document.activeElement).toBe(modal);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".signing-modal-footer button")];

    // When
    buttons[2].focus();
    fireEvent.keyDown(document, { key: "Tab" });

    // Then
    expect(document.activeElement).toBe(buttons[0]);

    // When
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    // Then
    expect(document.activeElement).toBe(buttons[2]);
  });

  it("As a dotli user, focus goes back to where it was when the dialog closes", async () => {
    // Given
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    void openModal(permissionLike());
    await mountOutlet();

    // When
    fireEvent.click(document.querySelector<HTMLButtonElement>(".signing-btn-cancel")!);
    await settle();

    // Then
    expect(document.activeElement).toBe(opener);
  });

  it("As a dotli user, the password field gets focus, Unlock waits for input, and Enter submits it", async () => {
    // Given
    const outcome = openModal(passwordView("Wrong password"));
    await mountOutlet();
    const input = document.querySelector<HTMLInputElement>("input.password-prompt-input")!;
    const unlock = document.querySelector<HTMLButtonElement>(".signing-btn-sign")!;

    // Then
    expect(document.activeElement).toBe(input);
    expect(input.type).toBe("password");
    expect(input.placeholder).toBe("Password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(document.querySelector(".password-prompt-error")?.textContent).toBe("Wrong password");
    expect(unlock.disabled).toBe(true);

    // When
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    // Then
    expect(document.querySelector(".signing-modal-backdrop")).not.toBeNull();

    // When
    fireEvent.input(input, { target: { value: "hunter2" } });
    await settle();

    // Then
    expect(unlock.disabled).toBe(false);

    // When
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: "unlock", value: "hunter2" });
  });

  it("As a dotli user, Cancel on the password dialog settles without the typed value", async () => {
    // Given
    const outcome = openModal(passwordView());
    await mountOutlet();
    fireEvent.input(document.querySelector<HTMLInputElement>("input.password-prompt-input")!, {
      target: { value: "typed" },
    });
    await settle();

    // When
    fireEvent.click(document.querySelector<HTMLButtonElement>(".signing-btn-cancel")!);
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: "cancel" });
  });

  it("As a dotli user, the next queued dialog gets focus after the first one closes", async () => {
    // Given
    void openModal(permissionLike());
    void openModal(permissionLike({ title: "Second" }));
    await mountOutlet();

    // When
    fireEvent.click(document.querySelector<HTMLButtonElement>(".signing-btn-cancel")!);
    await settle();

    // Then
    expect(document.querySelector("h2")?.textContent).toBe("Second");
    expect(document.activeElement).toBe(document.querySelector(".signing-modal"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/components/overlays/dialog.test.tsx`
Expected: FAIL, cannot resolve `@dotli/ui/components/overlays/ModalOutlet`.

- [ ] **Step 3: Write the components**

`packages/ui/src/components/overlays/Dialog.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared dialog shell: backdrop, dialog semantics, initial focus, a Tab trap,
// Escape, and focus restored on close.

import { onCleanup, onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";

export interface DialogProps {
  titleId: string;
  /** Element to focus first. Defaults to the dialog itself. */
  initialFocus?: () => HTMLElement | undefined;
  /** Backdrop click and Escape. */
  onDismiss: () => void;
  children: JSX.Element;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function trapTab(event: KeyboardEvent, dialog: HTMLElement): void {
  const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  } else if (!dialog.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

export function Dialog(props: DialogProps): JSX.Element {
  let backdrop!: HTMLDivElement;
  let dialog!: HTMLDivElement;
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onDismiss();
    } else if (event.key === "Tab") {
      trapTab(event, dialog);
    }
  };

  onSettled(() => {
    (props.initialFocus?.() ?? dialog).focus();
  });
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    document.removeEventListener("keydown", onKeyDown);
    if (previouslyFocused?.isConnected === true) {
      previouslyFocused.focus();
    }
  });

  return (
    <div
      class="signing-modal-backdrop"
      ref={backdrop}
      onClick={(event) => {
        if (event.target === backdrop) {
          props.onDismiss();
        }
      }}
    >
      <div
        class="signing-modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.titleId}
        tabindex="-1"
      >
        {props.children}
      </div>
    </div>
  );
}
```

`packages/ui/src/components/overlays/SigningDialog.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Renders one queued ModalView with the signing-modal markup shared by the
// permission, preimage, confirmation and password dialogs.

import { createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  settleModal,
  type ModalButton,
  type ModalButtonVariant,
  type ModalEntry,
} from "../../state/modals";
import { Dialog } from "./Dialog";

const BUTTON_CLASS: Record<ModalButtonVariant, string> = {
  cancel: "signing-btn-cancel",
  secondary: "signing-btn-secondary",
  primary: "signing-btn-sign",
};

export function SigningDialog(props: { entry: ModalEntry }): JSX.Element {
  // The outlet re-creates this component per entry (keyed), so reading once is intended.
  // eslint-disable-next-line solid/reactivity -- keyed entry, read once
  const { id, view } = props.entry;
  const titleId = `overlay-modal-title-${String(id)}`;
  const [password, setPassword] = createSignal("");
  let input: HTMLInputElement | undefined;

  const needsPassword = (button: ModalButton<string>): boolean =>
    view.input !== undefined && button.variant === "primary";

  const choose = (button: ModalButton<string>): void => {
    if (needsPassword(button)) {
      if (password() === "") {
        return;
      }
      settleModal(id, button.result, password());
      return;
    }
    settleModal(id, button.result);
  };

  const dismiss = (): void => {
    if (view.dismissOnBackdrop && view.dismissResult !== undefined) {
      settleModal(id, view.dismissResult);
    }
  };

  const submitWithEnter = (): void => {
    const primary = view.buttons.find((b) => b.variant === "primary");
    if (primary !== undefined) {
      choose(primary);
    }
  };

  return (
    <Dialog titleId={titleId} initialFocus={() => input} onDismiss={dismiss}>
      <Show when={view.icon}>
        {(icon) => <div class="permission-modal-icon" innerHTML={icon()} />}
      </Show>
      <h2 id={titleId}>{view.title}</h2>
      <div class="signing-fields">
        <For each={view.fields}>
          {(field) => (
            <div class={["signing-field", { "signing-field-warning": field.warning === true }]}>
              <div class="signing-field-label">{field.label}</div>
              <div class={["signing-field-value", { mono: field.mono === true }]}>
                {field.value}
              </div>
            </div>
          )}
        </For>
        <Show when={view.notice}>
          {(notice) => <div class="permission-modal-notice">{notice()}</div>}
        </Show>
        <Show when={view.input}>
          {(spec) => (
            <>
              <Show when={spec().hint}>
                {(hint) => <div class="signing-field-value">{hint()}</div>}
              </Show>
              <Show when={spec().error}>
                {(error) => <div class="password-prompt-error">{error()}</div>}
              </Show>
              <input
                ref={input}
                type="password"
                class="password-prompt-input"
                placeholder={spec().placeholder}
                autocomplete="off"
                spellcheck="false"
                onInput={(event) => setPassword(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    submitWithEnter();
                  }
                }}
              />
            </>
          )}
        </Show>
      </div>
      <div class="signing-modal-footer">
        <For each={view.buttons}>
          {(button) => (
            <button
              type="button"
              class={BUTTON_CLASS[button.variant]}
              disabled={needsPassword(button) && password() === ""}
              onClick={() => {
                choose(button);
              }}
            >
              {button.label}
            </button>
          )}
        </For>
      </div>
    </Dialog>
  );
}
```

`packages/ui/src/components/overlays/ModalOutlet.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { modalsStore, type ModalEntry } from "../../state/modals";
import { useStore } from "../use-store";
import { SigningDialog } from "./SigningDialog";

/** Shows the first queued dialog; the rest wait their turn. */
export function ModalOutlet(): JSX.Element {
  const entries = useStore(modalsStore);
  return (
    <Show when={entries()[0]} keyed>
      {(entry: ModalEntry) => <SigningDialog entry={entry} />}
    </Show>
  );
}
```

Then delete the toolchain probe, which the spec retires in this sub-project:

```bash
git rm packages/ui/src/components/dev/SolidProbe.tsx packages/ui/tests/components/solid-probe.test.tsx
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/components/overlays/dialog.test.tsx`
Expected: 9 passed. If `fireEvent.input(el, { target: { value } })` does not set the value in this testing-library version, set `input.value = "hunter2"` before `fireEvent.input(input)` and note it in the report. If the Tab-trap test fails because happy-dom moves focus on its own before the handler runs, report the observed `document.activeElement` rather than loosening the assertion.

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test`
Expected: all pass (the probe test is gone with the probe).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/overlays/Dialog.tsx packages/ui/src/components/overlays/SigningDialog.tsx packages/ui/src/components/overlays/ModalOutlet.tsx packages/ui/tests/components/overlays/dialog.test.tsx
git commit -m "feat(ui): add Solid dialog components for the overlays root"
```

---

### Task 4: Toast components

**Files:**
- Create: `packages/ui/src/components/overlays/ToastStack.tsx`
- Create: `packages/ui/src/components/overlays/ToastCard.tsx`
- Test: `packages/ui/tests/components/overlays/toast-stack.test.tsx`

**Interfaces:**
- Consumes: `toastsStore`, `pushToast`, `dismissToast`, `removeToast`, `dismissAllToasts`, `setToastsExpanded`, `resetToastsForTests`, `ToastEntry`, `ToastInput` (Task 2); `useStore`.
- Produces: `export function ToastStack(): JSX.Element`; `export function ToastCard(props: { entry: ToastEntry; hidden: boolean; depth: number }): JSX.Element`.

- [ ] **Step 1: Write the failing tests**

`packages/ui/tests/components/overlays/toast-stack.test.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { ToastStack } from "@dotli/ui/components/overlays/ToastStack";
import {
  dismissToast,
  pushToast,
  resetToastsForTests,
  toastsStore,
  type ToastInput,
} from "@dotli/ui/state/toasts";
import { renderComponent, settle } from "../../helpers/solid";

function input(label: string, overrides: Partial<ToastInput> = {}): ToastInput {
  return { text: `${label} body`, label, icon: "<svg></svg>", dismissMs: 0, ...overrides };
}

function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".notif-card")];
}

function visibleTitles(): string[] {
  return cards()
    .filter((c) => !c.classList.contains("notif-hidden-card"))
    .map((c) => c.querySelector(".notif-title")?.textContent ?? "");
}

async function mountStack(): Promise<void> {
  renderComponent(() => <ToastStack />);
  await settle();
}

afterEach(() => {
  resetToastsForTests();
  document.body.replaceChildren();
});

describe("toast stack", () => {
  it("As a dotli user, a toast renders today's card markup", async () => {
    // Given
    const onClick = vi.fn();
    pushToast(
      input("Update available", {
        deeplink: "https://dot.li/",
        iconBackground: "#000",
        action: { label: "Reload", onClick },
      }),
    );

    // When
    await mountStack();

    // Then
    const card = cards()[0];
    expect(card.classList.contains("notif-card")).toBe(true);
    expect(card.classList.contains("notif-enter")).toBe(true);
    expect(card.dataset.id).toBe("0");
    expect(card.querySelector<HTMLElement>(".notif-icon")?.style.background).not.toBe("");
    expect(card.querySelector(".notif-title")?.textContent).toBe("Update available");
    const body = card.querySelector<HTMLAnchorElement>("a.notif-body");
    expect(body?.href).toBe("https://dot.li/");
    expect(body?.target).toBe("_blank");
    expect(body?.rel).toBe("noopener");
    expect(card.querySelector(".notif-card-close")?.getAttribute("aria-label")).toBe("Dismiss");
    expect(document.querySelector(".notif-cards")?.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector(".notif-cards")?.getAttribute("role")).toBe("status");
    expect(document.querySelector(".notif-stack")?.classList.contains("single")).toBe(true);
    expect(document.querySelector<HTMLElement>(".notif-close-all")?.style.display).toBe("none");

    // When
    fireEvent.click(card.querySelector<HTMLButtonElement>(".notif-action")!);
    fireEvent.animationEnd(card);
    await settle();

    // Then
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(card.classList.contains("notif-enter")).toBe(false);
  });

  it("As a dotli user, only the newest three toasts are visible, with close-all shown", async () => {
    // Given
    for (const label of ["A", "B", "C", "D"]) {
      pushToast(input(label));
    }

    // When
    await mountStack();

    // Then
    expect(visibleTitles()).toEqual(["B", "C", "D"]);
    expect(cards()[0].classList.contains("notif-hidden-card")).toBe(true);
    expect(cards().slice(1).map((c) => c.style.getPropertyValue("--i"))).toEqual(["2", "1", "0"]);
    expect(document.querySelector<HTMLElement>(".notif-close-all")?.style.display).toBe("");
    expect(document.querySelector(".notif-stack")?.classList.contains("single")).toBe(false);
  });

  it("As a dotli user, closing a toast plays its exit and removes it when the animation ends", async () => {
    // Given
    pushToast(input("A"));
    await mountStack();
    const card = cards()[0];

    // When
    fireEvent.click(card.querySelector<HTMLButtonElement>(".notif-card-close")!);
    await settle();

    // Then
    expect(card.classList.contains("notif-leave")).toBe(true);
    expect(document.querySelector(".notif-stack")).not.toBeNull();

    // When
    fireEvent.animationEnd(card);
    await settle();

    // Then
    expect(document.querySelector(".notif-stack")).toBeNull();
    expect(toastsStore.get().items).toEqual([]);
  });

  it("As a dotli user, a toast hidden beyond the visible three disappears at once when dismissed", async () => {
    // Given
    const ids = ["A", "B", "C", "D"].map((label) => pushToast(input(label)));
    await mountStack();

    // When
    dismissToast(ids[0]);
    await settle();

    // Then
    expect(toastsStore.get().items.map((t) => t.label)).toEqual(["B", "C", "D"]);
    expect(cards()).toHaveLength(3);
  });

  it("As a dotli user, clicking the stack expands it, and clicking outside collapses it", async () => {
    // Given
    for (const label of ["A", "B", "C", "D"]) {
      pushToast(input(label));
    }
    await mountStack();

    // When
    fireEvent.click(document.querySelector<HTMLElement>(".notif-cards .notif-text")!);
    await settle();

    // Then
    expect(toastsStore.get().expanded).toBe(true);
    expect(document.querySelector(".notif-stack")?.classList.contains("expanded")).toBe(true);
    expect(visibleTitles()).toEqual(["A", "B", "C", "D"]);

    // When
    fireEvent.click(document.body);
    await settle();

    // Then
    expect(toastsStore.get().expanded).toBe(false);
    expect(visibleTitles()).toEqual(["B", "C", "D"]);
  });

  it("As a dotli user, clicking a link inside a toast does not expand the stack", async () => {
    // Given
    pushToast(input("A", { deeplink: "https://dot.li/" }));
    pushToast(input("B", { deeplink: "https://dot.li/" }));
    await mountStack();
    const link = document.querySelector<HTMLAnchorElement>("a.notif-body")!;
    link.addEventListener("click", (event) => {
      event.preventDefault();
    });

    // When
    fireEvent.click(link);
    await settle();

    // Then
    expect(toastsStore.get().expanded).toBe(false);
  });

  it("As a dotli user, dismiss all plays every exit and removes the stack once they finish", async () => {
    // Given
    pushToast(input("A"));
    pushToast(input("B"));
    await mountStack();

    // When
    fireEvent.click(document.querySelector<HTMLButtonElement>(".notif-close-all")!);
    await settle();

    // Then
    expect(cards().every((c) => c.classList.contains("notif-leave"))).toBe(true);
    expect(toastsStore.get().expanded).toBe(false);

    // When
    for (const card of cards()) {
      fireEvent.animationEnd(card);
    }
    await settle();

    // Then
    expect(document.querySelector(".notif-stack")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/components/overlays/toast-stack.test.tsx`
Expected: FAIL, cannot resolve `@dotli/ui/components/overlays/ToastStack`.

- [ ] **Step 3: Write the components**

`packages/ui/src/components/overlays/ToastCard.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { dismissToast, removeToast, type ToastEntry } from "../../state/toasts";

export const CLOSE_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<line x1="18" y1="6" x2="6" y2="18"/>' +
  '<line x1="6" y1="6" x2="18" y2="18"/></svg>';

export function ToastCard(props: {
  entry: ToastEntry;
  hidden: boolean;
  depth: number;
}): JSX.Element {
  // The id never changes for a card (the stack keys cards by id).
  // eslint-disable-next-line solid/reactivity -- stable key, read once
  const id = props.entry.id;
  const [entering, setEntering] = createSignal(true);
  // A leaving card keeps the layout it had when it started to leave.
  const hidden = createMemo<boolean>((prev) =>
    props.entry.leaving ? (prev ?? false) : props.hidden,
  );
  const depth = createMemo<number>((prev) =>
    props.entry.leaving ? (prev ?? 0) : props.depth,
  );

  // A hidden card is display:none, so no animationend would ever arrive.
  createEffect(
    () => props.entry.leaving && hidden(),
    (removeNow) => {
      if (removeNow) {
        removeToast(id);
      }
    },
  );

  return (
    <div
      class={[
        "notif-card",
        {
          "notif-enter": entering(),
          "notif-leave": props.entry.leaving,
          "notif-hidden-card": hidden(),
        },
      ]}
      data-id={String(id)}
      style={{ "--i": String(depth()) }}
      onAnimationEnd={() => {
        if (props.entry.leaving) {
          removeToast(id);
        } else {
          setEntering(false);
        }
      }}
    >
      <div
        class="notif-icon"
        innerHTML={props.entry.icon}
        style={
          props.entry.iconBackground === undefined
            ? undefined
            : { background: props.entry.iconBackground }
        }
      />
      <div class="notif-text">
        <span class="notif-title">{props.entry.label}</span>
        <Show
          when={props.entry.deeplink}
          fallback={<span class="notif-body">{props.entry.text}</span>}
        >
          {(href) => (
            <a class="notif-body" href={href()} target="_blank" rel="noopener">
              {props.entry.text}
            </a>
          )}
        </Show>
      </div>
      <Show when={props.entry.action}>
        {(action) => (
          <button
            type="button"
            class="notif-action"
            onClick={(event) => {
              event.stopPropagation();
              action().onClick();
            }}
          >
            {action().label}
          </button>
        )}
      </Show>
      <button
        type="button"
        class="notif-card-close"
        data-id={String(id)}
        aria-label="Dismiss"
        innerHTML={CLOSE_SVG}
        onClick={(event) => {
          event.stopPropagation();
          dismissToast(id);
        }}
      />
    </div>
  );
}
```

`packages/ui/src/components/overlays/ToastStack.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  dismissAllToasts,
  setToastsExpanded,
  toastsStore,
} from "../../state/toasts";
import { useStore } from "../use-store";
import { CLOSE_SVG, ToastCard } from "./ToastCard";

const MAX_STACK = 3;

export function ToastStack(): JSX.Element {
  const state = useStore(toastsStore);
  let root: HTMLDivElement | undefined;
  let cards: HTMLDivElement | undefined;

  const active = () => state().items.filter((t) => !t.leaving);
  const visible = () => (state().expanded ? active() : active().slice(-MAX_STACK));
  const isHidden = (id: number): boolean => !visible().some((t) => t.id === id);
  const depthOf = (id: number): number => {
    if (state().expanded) {
      return 0;
    }
    const shown = visible();
    return shown.length - 1 - shown.findIndex((t) => t.id === id);
  };

  // While expanded: scroll to the newest card, and collapse on an outside
  // click (capture phase) or when the window loses focus.
  createEffect(
    () => state().expanded,
    (expanded) => {
      if (!expanded) {
        return;
      }
      if (cards !== undefined) {
        cards.scrollTop = cards.scrollHeight;
      }
      const onOutsideClick = (event: MouseEvent): void => {
        if (root !== undefined && !root.contains(event.target as Node)) {
          setToastsExpanded(false);
        }
      };
      const onBlur = (): void => {
        setToastsExpanded(false);
      };
      document.addEventListener("click", onOutsideClick, true);
      window.addEventListener("blur", onBlur);
      return () => {
        document.removeEventListener("click", onOutsideClick, true);
        window.removeEventListener("blur", onBlur);
      };
    },
  );

  const onStackClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    if (
      !state().expanded &&
      state().items.length > 1 &&
      target.closest(".notif-cards") !== null &&
      target.closest("a") === null
    ) {
      setToastsExpanded(true);
    }
  };

  return (
    <Show when={state().items.length > 0}>
      <div
        ref={root}
        class={["notif-stack", { expanded: state().expanded, single: active().length <= 1 }]}
        onClick={onStackClick}
      >
        <div
          ref={cards}
          class="notif-cards"
          role="status"
          aria-live="polite"
          style={{ cursor: !state().expanded && active().length > 1 ? "pointer" : "" }}
        >
          <For each={state().items} keyed={(t) => t.id}>
            {(entry) => (
              <ToastCard
                entry={entry()}
                hidden={isHidden(entry().id)}
                depth={depthOf(entry().id)}
              />
            )}
          </For>
        </div>
        <button
          type="button"
          class="notif-close-all"
          aria-label="Dismiss all"
          innerHTML={CLOSE_SVG}
          style={{ display: active().length > 1 ? "" : "none" }}
          onClick={(event) => {
            event.stopPropagation();
            dismissAllToasts();
            setToastsExpanded(false);
          }}
        />
      </div>
    </Show>
  );
}
```

Note on dismiss-all: today's `dismissAll` resets `expanded` only after every exit animation; collapsing at click time instead keeps timers paused (they were finished by `dismissAllToasts`) and changes nothing visible, because every card is already leaving.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/components/overlays/toast-stack.test.tsx`
Expected: 7 passed. If a reactive `style` value of `""` leaves a stale property instead of clearing it in this RC, use `undefined` for the "no value" case and adjust the two `style.display === ""` assertions to match what the browser reports, explaining it in the report.

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/overlays/ToastStack.tsx packages/ui/src/components/overlays/ToastCard.tsx packages/ui/tests/components/overlays/toast-stack.test.tsx
git commit -m "feat(ui): add Solid toast stack components for the overlays root"
```

---

### Task 5: Overlays loader and mount

**Files:**
- Modify: `packages/ui/src/mount/root.ts` (`mountRoot` gains `options`)
- Modify: `packages/ui/tests/mount/root.test.tsx` (one new test)
- Create: `packages/ui/src/components/overlays/mount.tsx`
- Create: `packages/ui/src/overlays/load.ts`
- Create: `packages/ui/tests/helpers/overlays.ts`
- Test: `packages/ui/tests/overlays/load.test.ts`

**Interfaces:**
- Consumes: Task 1–4 exports; `ensureOverlayRoot()` from `mount/overlay-root.ts`; `captureException` from `@dotli/metrics/sentry`.
- Produces (exact):
  ```ts
  // mount/root.ts
  export interface MountRootOptions { onError?: (err: unknown) => void }
  export function mountRoot(name: string, container: HTMLElement, view: () => JSX.Element, options?: MountRootOptions): () => void;
  // components/overlays/mount.tsx
  export function mountOverlays(): () => void;
  // overlays/load.ts (Solid-free)
  export function ensureOverlays(): Promise<void>;     // never rejects
  export function prefetchOverlays(): void;
  export function presentModal<R extends string>(view: ModalView<R>, signal?: AbortSignal): Promise<ModalOutcome<R>>;
  export function presentToast(input: ToastInput): void;
  export function resetOverlayLoaderForTests(): void;
  // tests/helpers/overlays.ts
  export async function overlaysReady(): Promise<void>;
  export function resetOverlays(): void;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/ui/tests/mount/root.test.tsx`, inside its top-level `describe` (reuse that file's existing imports; add `vi` to the `vitest` import if missing):

```tsx
  it("As a dotli developer, a root's onError runs after a render error is reported", async () => {
    // Given
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onError = vi.fn();
    const boom = new Error("render failed");
    const Broken = (): JSX.Element => {
      throw boom;
    };

    // When
    mountRoot("broken-with-hook", container, () => <Broken />, { onError });
    await settle();

    // Then
    expect(onError).toHaveBeenCalledWith(boom);
    disposeRoot("broken-with-hook");
  });
```

If that file names its helpers differently (for example it imports `flush` rather than `settle`), follow the file's existing pattern for waiting and for importing `JSX`.

`packages/ui/tests/helpers/overlays.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { disposeRoot } from "@dotli/ui/mount/root";
import {
  ensureOverlays,
  resetOverlayLoaderForTests,
} from "@dotli/ui/overlays/load";
import { resetModalsForTests } from "@dotli/ui/state/modals";
import { resetToastsForTests } from "@dotli/ui/state/toasts";
import { settle } from "./solid";

/** Wait until the lazily loaded overlays root has mounted and rendered. */
export async function overlaysReady(): Promise<void> {
  await ensureOverlays();
  await settle();
}

/** Unmount the overlays root and forget queued dialogs and toasts. */
export function resetOverlays(): void {
  disposeRoot("overlays");
  resetOverlayLoaderForTests();
  resetModalsForTests();
  resetToastsForTests();
  document.getElementById("overlay-root")?.remove();
}
```

`packages/ui/tests/overlays/load.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

import { presentModal, presentToast, prefetchOverlays } from "@dotli/ui/overlays/load";
import { toastsStore } from "@dotli/ui/state/toasts";
import type { ModalView } from "@dotli/ui/state/modals";
import { overlaysReady, resetOverlays } from "../helpers/overlays";

const VIEW: ModalView<"no" | "yes" | "dismissed"> = {
  title: "Question",
  fields: [],
  buttons: [
    { label: "No", variant: "cancel", result: "no" },
    { label: "Yes", variant: "primary", result: "yes" },
  ],
  dismissOnBackdrop: true,
  dismissResult: "dismissed",
  fallbackResult: "dismissed",
};

afterEach(() => {
  resetOverlays();
  vi.unstubAllGlobals();
  vi.doUnmock("@dotli/ui/components/overlays/mount");
  vi.resetModules();
  sentry.captureException.mockReset();
  document.body.replaceChildren();
});

describe("overlays loader", () => {
  it("As a dotli user, a toast pushed before the overlays mount appears once they do", async () => {
    // Given
    presentToast({ text: "Boot banner", label: "Hello", icon: "<svg></svg>", dismissMs: 0 });
    expect(document.querySelector(".notif-card")).toBeNull();

    // When
    await overlaysReady();

    // Then
    expect(document.querySelector("#overlay-root .notif-title")?.textContent).toBe("Hello");
  });

  it("As a dotli user, a dialog renders into the overlay root and settles from its buttons", async () => {
    // Given
    const outcome = presentModal(VIEW);
    await overlaysReady();

    // When
    document.querySelector<HTMLButtonElement>("#overlay-root .signing-btn-sign")?.click();

    // Then
    await expect(outcome).resolves.toEqual({ result: "yes" });
  });

  it("As a dotli integrator, an aborted signal rejects before anything renders or loads", async () => {
    // Given
    const controller = new AbortController();
    controller.abort();

    // When
    const outcome = presentModal(VIEW, controller.signal);

    // Then
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
    expect(document.getElementById("overlay-root")).toBeNull();
  });

  it("As a dotli integrator, aborting while the overlays are still loading never shows the dialog", async () => {
    // Given
    const controller = new AbortController();
    const outcome = presentModal(VIEW, controller.signal);

    // When
    controller.abort();
    await overlaysReady();

    // Then
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
  });

  it("As a dotli user, prefetching mounts the overlays when the browser is idle", async () => {
    // Given
    const idle = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", idle);

    // When
    prefetchOverlays();
    await overlaysReady();

    // Then
    expect(idle).toHaveBeenCalledTimes(1);
    expect(document.getElementById("overlay-root")).not.toBeNull();
  });

  it("As a dotli user, when the overlay code cannot load, action toasts fall back to a confirm and dialogs settle with their fallback", async () => {
    // Given
    vi.resetModules();
    vi.doMock("@dotli/ui/components/overlays/mount", () => {
      throw new Error("chunk failed");
    });
    const load = await import("@dotli/ui/overlays/load");
    const toasts = await import("@dotli/ui/state/toasts");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const onClick = vi.fn();
    load.presentToast({
      text: "A new version may have been deployed.",
      label: "Asset failed to load",
      icon: "<svg></svg>",
      dismissMs: 0,
      action: { label: "Reload", onClick },
    });
    load.presentToast({ text: "Plain", label: "Info", icon: "<svg></svg>", dismissMs: 0 });
    const outcome = load.presentModal(VIEW);

    // When
    await load.ensureOverlays();

    // Then
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      kind: "overlays_load_error",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("Asset failed to load\n\nA new version may have been deployed.");
    expect(onClick).toHaveBeenCalledTimes(1);
    await expect(outcome).resolves.toEqual({ result: "dismissed" });
    expect(toasts.toastsStore.get().items).toEqual([]);
  });

  it("As a dotli user, the overlays keep the toast store in sync with what is shown", async () => {
    // Given
    presentToast({ text: "One", label: "A", icon: "<svg></svg>", dismissMs: 0 });

    // When
    await overlaysReady();

    // Then
    expect(toastsStore.get().items.map((t) => t.label)).toEqual(["A"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/overlays/load.test.ts tests/mount/root.test.tsx`
Expected: FAIL, cannot resolve `@dotli/ui/overlays/load`; the new root test fails because `onError` is never called.

- [ ] **Step 3: Implement**

In `packages/ui/src/mount/root.ts`, add the options type and parameter, and call it after the report. The changed parts:

```ts
export interface MountRootOptions {
  /** Called after a render error has been reported. */
  onError?: (err: unknown) => void;
}

export function mountRoot(
  name: string,
  container: HTMLElement,
  view: () => JSX.Element,
  options: MountRootOptions = {},
): () => void {
  disposeRoot(name);
  const dispose = render(
    () =>
      createComponent(Errored, {
        fallback: (err: () => unknown) => {
          const error = err();
          reportRootErrorOnce(error, name);
          options.onError?.(error);
          return null;
        },
        get children() {
          return view();
        },
      }),
    container,
  );
```

Also extend the JSDoc of `mountRoot` with one sentence: "`options.onError` runs after the report, so a root can settle work that depended on it."

`packages/ui/src/components/overlays/mount.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded overlays chunk. Only overlays/load.ts imports it.

import { ensureOverlayRoot } from "../../mount/overlay-root";
import { mountRoot } from "../../mount/root";
import { failAllModals } from "../../state/modals";
import { clearToasts } from "../../state/toasts";
import { ModalOutlet } from "./ModalOutlet";
import { ToastStack } from "./ToastStack";

export function mountOverlays(): () => void {
  return mountRoot(
    "overlays",
    ensureOverlayRoot(),
    () => (
      <>
        <ToastStack />
        <ModalOutlet />
      </>
    ),
    {
      // A render error must not leave a permission or signing promise hanging.
      onError: () => {
        failAllModals();
        clearToasts();
      },
    },
  );
}
```

`packages/ui/src/overlays/load.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the Solid overlays chunk on first use, so neither app's startup
// bundle carries Solid. Everything here is Solid-free: it writes the stores
// and imports the chunk dynamically.

import { captureException } from "@dotli/metrics/sentry";
import {
  failAllModals,
  openModal,
  type ModalOutcome,
  type ModalView,
} from "../state/modals";
import {
  clearToasts,
  pushToast,
  toastsStore,
  type ToastInput,
} from "../state/toasts";

const PREFETCH_FALLBACK_MS = 2000;

let loading: Promise<void> | null = null;

/**
 * When the chunk cannot load: action toasts ("Reload") become a native
 * confirm, other toasts are dropped unseen, and dialogs settle with their
 * fallback result so no caller waits forever.
 */
function fallBack(): void {
  for (const toast of toastsStore.get().items) {
    if (
      toast.action !== undefined &&
      !toast.leaving &&
      window.confirm(`${toast.label}\n\n${toast.text}`)
    ) {
      toast.action.onClick();
    }
  }
  clearToasts();
  failAllModals();
}

/** Import and mount the overlays root once. Never rejects. */
export function ensureOverlays(): Promise<void> {
  loading ??= import("../components/overlays/mount")
    .then(({ mountOverlays }) => {
      mountOverlays();
    })
    .catch((err: unknown) => {
      loading = null;
      captureException(err, { kind: "overlays_load_error" });
      fallBack();
    });
  return loading;
}

/** Load the overlays when the browser is idle, before anything needs them. */
export function prefetchOverlays(): void {
  const run = (): void => {
    void ensureOverlays();
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run);
  } else {
    setTimeout(run, PREFETCH_FALLBACK_MS);
  }
}

/** Queue a dialog and make sure the overlays are there to show it. */
export function presentModal<R extends string>(
  view: ModalView<R>,
  signal?: AbortSignal,
): Promise<ModalOutcome<R>> {
  const outcome = openModal(view, signal);
  if (signal?.aborted !== true) {
    void ensureOverlays();
  }
  return outcome;
}

/** Queue a toast and make sure the overlays are there to show it. */
export function presentToast(input: ToastInput): void {
  pushToast(input);
  void ensureOverlays();
}

/** Tests only. */
export function resetOverlayLoaderForTests(): void {
  loading = null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/overlays/load.test.ts tests/mount/root.test.tsx`
Expected: all pass (7 in `load.test.ts`, the root file's previous count + 1). If `vi.doMock` with a throwing factory does not make the dynamic import reject in Vitest 5, use a factory that returns `{ mountOverlays: () => { throw new Error("chunk failed"); } }` instead (it exercises the same `.catch` path) and note it in the report.

Check the Solid-free rule: `grep -nE "solid-js|@solidjs|/components/|mount/root" packages/ui/src/overlays/load.ts packages/ui/src/state/modals.ts packages/ui/src/state/toasts.ts`
Expected: only the `import("../components/overlays/mount")` line in `load.ts`.

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/mount/root.ts packages/ui/tests/mount/root.test.tsx packages/ui/src/components/overlays/mount.tsx packages/ui/src/overlays/load.ts packages/ui/tests/helpers/overlays.ts packages/ui/tests/overlays/load.test.ts
git commit -m "feat(ui): lazily load and mount the overlays root"
```

---

### Task 6: Permission, preimage and password dialogs on the overlays root

**Files:**
- Modify: `packages/ui/src/permission-modal.ts` (replace `showPermissionRequestModal`'s body; keep `PERMISSION_DESCRIPTIONS`, `PERMISSION_ICONS`, types, and the header comment's first paragraph)
- Modify: `packages/ui/src/preimage-modal.ts`
- Modify: `packages/ui/src/password-prompt.ts`
- Modify: `packages/ui/tests/permission-modal.test.ts`, `packages/ui/tests/permissions.test.ts`
- Create: `packages/ui/tests/preimage-modal.test.ts`, `packages/ui/tests/password-prompt.test.ts`

**Interfaces:**
- Consumes: `presentModal` (Task 5), `ModalButton`, `ModalView` (Task 1), `overlaysReady`, `resetOverlays` (Task 5 test helper).
- Produces: unchanged public signatures:
  - `showPermissionRequestModal(label: string, permission: EnforceablePermissionName, signal?: AbortSignal, options?: PermissionRequestModalOptions): Promise<PermissionPromptDecision>`
  - `showPreimageSubmitModal(dataSize: number, signal?: AbortSignal): Promise<void>`
  - `showPasswordPrompt(opts?: { error?: string }): Promise<string>`

- [ ] **Step 1: Write the new tests**

`packages/ui/tests/preimage-modal.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { showPreimageSubmitModal } from "@dotli/ui/preimage-modal";
import { ERRORS } from "@dotli/ui/errors";
import { overlaysReady, resetOverlays } from "./helpers/overlays";

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

describe("preimage submit modal", () => {
  it("As a dotli user, I see the data size and can allow the submission", async () => {
    // Given
    const decision = showPreimageSubmitModal(2048);
    await overlaysReady();

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe("Submit Preimage");
    expect(document.querySelector(".signing-field-label")?.textContent).toBe("Data size");
    expect(document.querySelector(".signing-field-value")?.textContent).toBe("2 KB");

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(decision).resolves.toBeUndefined();
  });

  it("As a dotli user, cancelling rejects with the pinned error, and the backdrop does nothing", async () => {
    // Given
    const decision = showPreimageSubmitModal(512);
    await overlaysReady();
    expect(document.querySelector(".signing-field-value")?.textContent).toBe("512 B");

    // When
    document.querySelector<HTMLElement>(".signing-modal-backdrop")?.click();

    // Then
    expect(document.querySelector(".signing-modal-backdrop")).not.toBeNull();

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();

    // Then
    await expect(decision).rejects.toThrow(ERRORS.PREIMAGE_SUBMIT_DENIED);
  });

  it("As a dotli integrator, an abort rejects with AbortError and closes the dialog", async () => {
    // Given
    const controller = new AbortController();
    const decision = showPreimageSubmitModal(10, controller.signal);
    await overlaysReady();

    // When
    controller.abort();

    // Then
    await expect(decision).rejects.toMatchObject({ name: "AbortError" });
  });
});
```

`packages/ui/tests/password-prompt.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { showPasswordPrompt } from "@dotli/ui/password-prompt";
import { ERRORS } from "@dotli/ui/errors";
import { failAllModals } from "@dotli/ui/state/modals";
import { settle } from "./helpers/solid";
import { overlaysReady, resetOverlays } from "./helpers/overlays";

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

function type(value: string): void {
  const input = document.querySelector<HTMLInputElement>("input.password-prompt-input")!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("password prompt", () => {
  it("As a dotli user, I see the encrypted-content prompt and unlock with my password", async () => {
    // Given
    const password = showPasswordPrompt();
    await overlaysReady();

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe("Encrypted Content");
    expect(document.querySelector(".permission-modal-icon svg")).not.toBeNull();
    expect(document.querySelector(".signing-fields > .signing-field-value")?.textContent).toBe(
      "This content is password-protected. Enter the password to decrypt.",
    );
    expect(document.querySelector(".password-prompt-error")).toBeNull();

    // When
    type("hunter2");
    await settle();
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(password).resolves.toBe("hunter2");
  });

  it("As a dotli user who typed a wrong password, I see the error and can cancel", async () => {
    // Given
    const password = showPasswordPrompt({ error: "Wrong password" });
    await overlaysReady();

    // Then
    expect(document.querySelector(".password-prompt-error")?.textContent).toBe("Wrong password");

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();

    // Then
    await expect(password).rejects.toThrow(ERRORS.DECRYPTION_CANCELLED);
  });

  it("As a dotli user, if the prompt cannot be shown the sandbox gets a cancellation", async () => {
    // Given
    const password = showPasswordPrompt();

    // When
    failAllModals();

    // Then
    await expect(password).rejects.toThrow(ERRORS.DECRYPTION_CANCELLED);
  });
});
```

- [ ] **Step 2: Update the existing tests for lazy rendering**

In `packages/ui/tests/permission-modal.test.ts`:
- Replace the `afterEach` body with `resetOverlays(); document.body.replaceChildren();` and import `{ overlaysReady, resetOverlays } from "./helpers/overlays"`.
- Make every test `async` and add `await overlaysReady();` right after each `showPermissionRequestModal(...)` call, before the first DOM query or click. Do not change any assertion.
- Add one test at the end of the `describe`:

```ts
  it("As a dotli integrator, aborting while the dialog is still loading never shows it", async () => {
    // Given
    const controller = new AbortController();
    const decision = showPermissionRequestModal("myapp", "Camera", controller.signal);

    // When
    controller.abort();
    await overlaysReady();

    // Then
    await expect(decision).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector(".signing-modal-backdrop")).toBeNull();
  });
```

In `packages/ui/tests/permissions.test.ts`: where a test expects a modal to appear (lines around 466 and 515 already wait with `vi.waitFor` / polling) or queries `.signing-modal-*`, keep the assertions and make sure the file resets overlays between tests: add `resetOverlays()` to its existing `afterEach` (create one if absent) and import it from `./helpers/overlays`. Where a synchronous `querySelector` right after the call now finds nothing, insert `await overlaysReady();` before it. Do not weaken or remove assertions.

- [ ] **Step 3: Run the tests to verify the new ones fail**

Run: `bun run --cwd packages/ui test tests/preimage-modal.test.ts tests/password-prompt.test.ts tests/permission-modal.test.ts`
Expected: FAIL. The old modules still append to `document.body` directly and never use the overlays, so for example the password fallback test hangs until timeout and the abort-while-loading test finds a backdrop.

- [ ] **Step 4: Rewrite the three modules as wrappers**

`packages/ui/src/permission-modal.ts`: keep the license header, the imports of `withActiveTld`, `isDevicePermission`, `EnforceablePermissionName`, `PERMISSION_DESCRIPTIONS`, `PERMISSION_ICONS`, `PermissionPromptDecision`, `PermissionRequestModalOptions`. Replace the `blockingModalAbortError` import with `import { presentModal } from "./overlays/load";` and `import type { ModalButton } from "./state/modals";`. Change the last line of the header comment from "DOM structure follows the signing modal pattern (signing.css)." to "Rendered by the overlays root (components/overlays/SigningDialog.tsx)." and delete the "(vanilla DOM)" suffix on the first comment line. Replace the function:

```ts
/**
 * Show a permission request modal.
 */
export async function showPermissionRequestModal(
  label: string,
  permission: EnforceablePermissionName,
  signal?: AbortSignal,
  options: PermissionRequestModalOptions = {},
): Promise<PermissionPromptDecision> {
  const allowOnce = options.allowOnce === true;
  const buttons: ModalButton<PermissionPromptDecision>[] = [
    { label: "Deny", variant: "cancel", result: "denied" },
    allowOnce
      ? { label: "Always allow", variant: "secondary", result: "granted" }
      : { label: "Allow", variant: "primary", result: "granted" },
  ];
  if (allowOnce) {
    buttons.push({ label: "Allow once", variant: "primary", result: "granted-once" });
  }
  const { result } = await presentModal<PermissionPromptDecision>(
    {
      icon: PERMISSION_ICONS[permission],
      title: "Permission Request",
      fields: [
        { label: "Application", value: withActiveTld(label) },
        { label: "Permission", value: PERMISSION_DESCRIPTIONS[permission] },
      ],
      ...(isDevicePermission(permission)
        ? { notice: "Granting this permission will reload the application." }
        : {}),
      buttons,
      dismissOnBackdrop: true,
      dismissResult: "dismissed",
      fallbackResult: "dismissed",
    },
    signal,
  );
  return result;
}
```

`packages/ui/src/preimage-modal.ts` (whole file):

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Preimage submit confirmation modal
//
// Shows a confirmation dialog when a product requests to store
// preimage data on the Bulletin chain. Returns a Promise that
// resolves on "Allow" and rejects on "Cancel".
//
// Rendered by the overlays root (components/overlays/SigningDialog.tsx).

import { ERRORS } from "./errors";
import { presentModal } from "./overlays/load";

function formatSize(bytes: number): string {
  return bytes >= 1024
    ? `${String(Math.round(bytes / 1024))} KB`
    : `${String(bytes)} B`;
}

export async function showPreimageSubmitModal(
  dataSize: number,
  signal?: AbortSignal,
): Promise<void> {
  const { result } = await presentModal<"cancel" | "allow">(
    {
      title: "Submit Preimage",
      fields: [{ label: "Data size", value: formatSize(dataSize) }],
      buttons: [
        { label: "Cancel", variant: "cancel", result: "cancel" },
        { label: "Allow", variant: "primary", result: "allow" },
      ],
      dismissOnBackdrop: false,
      fallbackResult: "cancel",
    },
    signal,
  );
  if (result !== "allow") {
    throw new Error(ERRORS.PREIMAGE_SUBMIT_DENIED);
  }
}
```

`packages/ui/src/password-prompt.ts` (whole file):

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Password prompt modal for encrypted SPAs
//
// Asks the user for a decryption password. Clicking the backdrop does not
// dismiss it: encrypted content has no fallback to show, so the user must
// cancel or submit. Rendered by the overlays root.

import { ERRORS } from "./errors";
import { presentModal } from "./overlays/load";

const LOCK_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
  '<path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

/**
 * Show a password prompt modal. Resolves with the entered password,
 * or rejects if the user cancels.
 */
export async function showPasswordPrompt(opts?: {
  error?: string;
}): Promise<string> {
  const outcome = await presentModal<"cancel" | "unlock">({
    icon: LOCK_SVG,
    title: "Encrypted Content",
    fields: [],
    input: {
      kind: "password",
      placeholder: "Password",
      hint: "This content is password-protected. Enter the password to decrypt.",
      ...(opts?.error !== undefined && opts.error !== "" ? { error: opts.error } : {}),
    },
    buttons: [
      { label: "Cancel", variant: "cancel", result: "cancel" },
      { label: "Unlock", variant: "primary", result: "unlock" },
    ],
    dismissOnBackdrop: false,
    fallbackResult: "cancel",
  });
  if (outcome.result !== "unlock" || outcome.value === undefined || outcome.value === "") {
    throw new Error(ERRORS.DECRYPTION_CANCELLED);
  }
  return outcome.value;
}
```

Note: `showPermissionRequestModal` becomes `async`. With an already-aborted signal it now returns a rejected promise instead of rejecting from inside a `new Promise` executor; both are rejections with the same `AbortError`, so callers see no difference.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/preimage-modal.test.ts tests/password-prompt.test.ts tests/permission-modal.test.ts tests/permissions.test.ts tests/rate-limit.test.ts`
Expected: all pass (3 + 3 + 8 + the files' existing counts).

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test`
Expected: all pass. `user-confirmation.test.ts` and `blocking-modal-queue.test.ts` still pass unchanged here: the confirmation dialog is still hand-built until Task 7, and the preimage path inside it now renders lazily. If a preimage-related test in `user-confirmation.test.ts` fails now because it queries synchronously, add `await overlaysReady();` (and `resetOverlays()` in its `afterEach`) for that test only and say so in the report.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/permission-modal.ts packages/ui/src/preimage-modal.ts packages/ui/src/password-prompt.ts packages/ui/tests/permission-modal.test.ts packages/ui/tests/permissions.test.ts packages/ui/tests/preimage-modal.test.ts packages/ui/tests/password-prompt.test.ts
git commit -m "refactor(ui): render permission, preimage and password dialogs in the overlays root"
```

(Add `packages/ui/tests/user-confirmation.test.ts` to the `git add` only if Step 5 required the preimage fix there.)

---

### Task 7: Confirmation dialog on the overlays root

**Files:**
- Modify: `packages/ui/src/host-callbacks/UserConfirmation.ts` (replace `showConfirmationModal` and delete `createField`; all copy, field builders and adapters stay)
- Modify: `packages/ui/tests/user-confirmation.test.ts`, `packages/ui/tests/blocking-modal-queue.test.ts`

**Interfaces:**
- Consumes: `presentModal` (Task 5); `ModalButton`, `ModalField` (Task 1); `overlaysReady`, `resetOverlays` (test helper).
- Produces: unchanged `createUserConfirmationAdapters(label: string, modalScope?: BlockingModalScope): Required<UserConfirmationHost>`.

- [ ] **Step 1: Update the tests for lazy rendering (they become the failing tests)**

In `packages/ui/tests/user-confirmation.test.ts` and `packages/ui/tests/blocking-modal-queue.test.ts`:
- Import `{ overlaysReady, resetOverlays } from "./helpers/overlays"`; in `afterEach` call `resetOverlays()` before the existing `document.body.replaceChildren()`.
- After every call that opens a dialog (`confirmUserAction(...)`, `confirmPermission(...)`) and after every click that should reveal the next queued dialog, add `await overlaysReady();` before the next DOM query. Do not change any assertion.

Add one test to `user-confirmation.test.ts`, inside its `describe`:

```ts
  it("As a dotli user, the confirmation dialog is announced as a dialog and dismissed with Escape", async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters("localhost:3000");
    const accepted = confirmUserAction({
      tag: "AccountAccess",
      value: { requestingProductId: "a.dot", targetProductId: "b.dot" },
    });
    await overlaysReady();

    // Then
    expect(document.querySelector(".signing-modal")?.getAttribute("role")).toBe("dialog");

    // When
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // Then
    await expect(accepted).resolves.toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `bun run --cwd packages/ui test tests/user-confirmation.test.ts tests/blocking-modal-queue.test.ts`
Expected: the new Escape test FAILS (the hand-built dialog has no `role` and ignores Escape). The others may pass or fail depending on timing; either is fine at this step.

- [ ] **Step 3: Replace the hand-built dialog**

In `packages/ui/src/host-callbacks/UserConfirmation.ts`:
- Remove `blockingModalAbortError` from the `../blocking-modal-queue` import (keep `createBlockingModalScope`, `throwIfAborted`, `BlockingModalScope`).
- Add `import { presentModal } from "../overlays/load";` and `import type { ModalButton, ModalField } from "../state/modals";`.
- Replace `interface ConfirmationField { … }` with `type ConfirmationField = ModalField;` (every field builder keeps its return type).
- Delete `createField`.
- Replace `showConfirmationModal` with:

```ts
/**
 * With `allowOnce`, "Allow once" is offered and highlighted, and the lasting
 * grant is labelled "Always allow".
 */
async function showConfirmationModal(
  label: string,
  copy: ConfirmationCopy,
  review: ModalReview,
  signal: AbortSignal,
  allowOnce: boolean,
): Promise<ConfirmationDecision> {
  const buttons: ModalButton<ConfirmationDecision>[] = [
    { label: copy.cancelAction ?? "Cancel", variant: "cancel", result: "rejected" },
    allowOnce
      ? { label: "Always allow", variant: "secondary", result: "accepted" }
      : { label: copy.action, variant: "primary", result: "accepted" },
  ];
  if (allowOnce) {
    buttons.push({ label: "Allow once", variant: "primary", result: "accepted-once" });
  }
  const { result } = await presentModal<ConfirmationDecision>(
    {
      title: copy.title,
      fields: confirmationDisplay(label, review).fields,
      buttons,
      dismissOnBackdrop: true,
      dismissResult: "dismissed",
      fallbackResult: "dismissed",
    },
    signal,
  );
  return result;
}
```

`handleConfirmationReview`, `handlePreimageSubmitReview`, `permissionDecision`, `confirmationCopy`, all field builders and `createUserConfirmationAdapters` are unchanged. An already-aborted signal still rejects with `AbortError` (now from `openModal`, previously from `throwIfAborted`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/user-confirmation.test.ts tests/blocking-modal-queue.test.ts`
Expected: 24 + 6 passed.

Run: `grep -n "document.createElement\|backdrop.remove\|appendChild" packages/ui/src/host-callbacks/UserConfirmation.ts packages/ui/src/permission-modal.ts packages/ui/src/preimage-modal.ts packages/ui/src/password-prompt.ts`
Expected: no output.

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/host-callbacks/UserConfirmation.ts packages/ui/tests/user-confirmation.test.ts packages/ui/tests/blocking-modal-queue.test.ts
git commit -m "refactor(ui): render confirmation dialogs in the overlays root"
```

---

### Task 8: Toasts on the overlays root

**Files:**
- Modify: `packages/ui/src/notification.ts`
- Modify: `packages/ui/tests/notification.test.ts`
- Create: `packages/ui/tests/show-notification.test.ts`

**Interfaces:**
- Consumes: `presentToast` (Task 5); `overlaysReady`, `resetOverlays` (test helper).
- Produces: unchanged `showNotification(params: NotificationParams): void`, `NotificationParams`, `NOTIFICATION_DISMISS_MS = 10_000`.

- [ ] **Step 1: Write the failing tests**

`packages/ui/tests/show-notification.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_DISMISS_MS, showNotification } from "@dotli/ui/notification";
import { toastsStore } from "@dotli/ui/state/toasts";
import { overlaysReady, resetOverlays } from "./helpers/overlays";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

beforeEach(() => {
  setVisibility("visible");
});

afterEach(() => {
  resetOverlays();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("showNotification", () => {
  it("As a dotli user, a notification appears in the overlay root with the default bell icon", async () => {
    // When
    showNotification({ label: "Hello", text: "  World  " });
    await overlaysReady();

    // Then
    expect(document.querySelector("#overlay-root .notif-title")?.textContent).toBe("Hello");
    expect(document.querySelector("#overlay-root .notif-body")?.textContent).toBe("World");
    expect(document.querySelector("#overlay-root .notif-icon svg")).not.toBeNull();
  });

  it("As a dotli integrator, empty text shows nothing, long text is cut to 200 characters, and non-http links are dropped", () => {
    // When
    showNotification({ label: "Empty", text: "   " });
    showNotification({ label: "Long", text: "x".repeat(250), deeplink: "javascript:alert(1)" });

    // Then
    const items = toastsStore.get().items;
    expect(items.map((t) => t.label)).toEqual(["Long"]);
    expect(items[0].text).toHaveLength(200);
    expect(items[0].deeplink).toBeUndefined();
  });

  it("As a dotli user, a notification leaves after the default delay", () => {
    // Given
    vi.useFakeTimers();
    showNotification({ label: "Timed", text: "Body" });

    // When
    vi.advanceTimersByTime(NOTIFICATION_DISMISS_MS);

    // Then
    expect(toastsStore.get().items.map((t) => t.leaving)).toEqual([true]);
    vi.useRealTimers();
  });

  it("As a dotli user with the tab hidden, I also get a system notification when permission is granted", () => {
    // Given
    const created: { title: string; body: string | undefined }[] = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn();
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        created.push({ title, body: options?.body });
      }
      close(): void {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    setVisibility("hidden");

    // When
    showNotification({ label: "Ping", text: "Background" });
    showNotification({ label: "Quiet", text: "No system one", browserNotification: false });

    // Then
    expect(created).toEqual([{ title: "Ping", body: "Background" }]);
  });
});
```

In `packages/ui/tests/notification.test.ts`: that file calls `vi.resetModules()` in `beforeEach`, so the overlays loader must be imported fresh after it. In the test that asserts `.notif-body` text, right before that assertion add:

```ts
    const { ensureOverlays } = await import("@dotli/ui/overlays/load");
    await ensureOverlays();
    await new Promise((resolve) => setTimeout(resolve, 0));
```

Keep every assertion unchanged. If other tests in that file query toast DOM, apply the same three lines before their queries.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/show-notification.test.ts`
Expected: FAIL: the first test finds no `#overlay-root .notif-title` (the old module renders into its own `.notif-stack` on `body`), and the second finds no entries in `toastsStore`.

- [ ] **Step 3: Rewrite `notification.ts`**

Whole file:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Notification display
//
// Stackable toasts, rendered by the overlays root (components/overlays/
// ToastStack.tsx) from the toast store. Auto-dismiss pauses while the tab is
// hidden or the stack is expanded. Optionally fires the browser Notification
// API when the tab is hidden; that part does not depend on the overlays.

import { presentToast } from "./overlays/load";

/** Default auto-dismiss delay in ms. */
export const NOTIFICATION_DISMISS_MS = 10_000;

const BELL_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>' +
  '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

export interface NotificationParams {
  text: string;
  label: string;
  deeplink?: string;
  /** SVG string for the icon. Default: bell. */
  icon?: string;
  /** CSS color for an icon background. Default: inherits from .notif-icon (#0a0a0a). */
  iconBackground?: string;
  /** Auto-dismiss in ms. 0 = persistent (manual close only). Default: NOTIFICATION_DISMISS_MS. */
  dismissMs?: number;
  /** Send browser Notification API when the tab is hidden. Default: true. */
  browserNotification?: boolean;
  /** Called when the notification is dismissed (user close or auto-dismiss). */
  onDismiss?: () => void;
  /** Optional action button rendered next to the text area. */
  action?: { label: string; onClick: () => void };
}

function sanitizeText(raw: string): string {
  return raw.trim().slice(0, 200);
}

function validateDeeplink(dl: string | undefined): string | undefined {
  if (dl === undefined || dl === "") {
    return undefined;
  }
  try {
    const u = new URL(dl);
    return u.protocol === "https:" || u.protocol === "http:" ? dl : undefined;
  } catch {
    return undefined;
  }
}

// Browser Notification, used as a supplement when the tab is hidden.
function fireBrowserNotification(
  text: string,
  deeplink: string | undefined,
  label: string,
): void {
  if (!("Notification" in window)) {
    return;
  }

  const show = (): void => {
    const n = new Notification(label, { body: text });
    n.onclick = () => {
      window.focus();
      if (deeplink !== undefined && deeplink !== "") {
        window.open(deeplink, "_blank");
      }
    };
    setTimeout(() => {
      n.close();
    }, 5000);
  };

  if (Notification.permission === "granted") {
    show();
  } else if (Notification.permission !== "denied") {
    void Notification.requestPermission().then((p) => {
      if (p === "granted") {
        show();
      }
    });
  }
}

export function showNotification(params: NotificationParams): void {
  const text = sanitizeText(params.text);
  if (!text) {
    return;
  }
  const deeplink = validateDeeplink(params.deeplink);

  presentToast({
    text,
    label: params.label,
    icon: params.icon ?? BELL_SVG,
    dismissMs: params.dismissMs ?? NOTIFICATION_DISMISS_MS,
    ...(deeplink === undefined ? {} : { deeplink }),
    ...(params.iconBackground === undefined || params.iconBackground === ""
      ? {}
      : { iconBackground: params.iconBackground }),
    ...(params.onDismiss === undefined ? {} : { onDismiss: params.onDismiss }),
    ...(params.action === undefined ? {} : { action: params.action }),
  });

  if ((params.browserNotification ?? true) && document.visibilityState !== "visible") {
    fireBrowserNotification(text, deeplink, params.label);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/show-notification.test.ts tests/notification.test.ts`
Expected: 4 + 4 passed.

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test && bun run typecheck && bun run lint && bun run test`
Expected: all pass (the host and sandbox typecheck against the unchanged signatures).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/notification.ts packages/ui/tests/notification.test.ts packages/ui/tests/show-notification.test.ts
git commit -m "refactor(ui): render toasts in the overlays root"
```

---

### Task 9: Prefetch in the apps, gates and verification

**Files:**
- Modify: `apps/host/src/main.ts` (one import, one call)
- Modify: `apps/sandbox/src/main.ts` (one import, one call)
- Modify: `docs/perf/solid-migration-baseline.md` (new section "After sub-project 1")

**Interfaces:**
- Consumes: `prefetchOverlays(): void` from `@dotli/ui/overlays/load`; `scripts/eager-path-size.ts`.

Placeholders in this task: `<repo>` is the repository root (`/Users/zhuravlev/Projects/Parity/dotli-community`); `<scratchpad>` is the session scratchpad directory the controller gives you.

- [ ] **Step 1: Prefetch the overlays after boot**

In `apps/host/src/main.ts`, add `import { prefetchOverlays } from "@dotli/ui/overlays/load";` with the other `@dotli/ui/*` imports, and directly after the `window.addEventListener("vite:preloadError", …)` block (it starts at line 166) add:

```ts
// Fetch the toast/modal chunk while the browser is idle, so it is in memory
// before a deploy could make later chunk loads fail.
prefetchOverlays();
```

In `apps/sandbox/src/main.ts`, add the same import and the same call with the same comment directly after its `window.addEventListener("vite:preloadError", …)` block (it starts at line 21).

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass.

```bash
git add apps/host/src/main.ts apps/sandbox/src/main.ts
git commit -m "feat: prefetch the overlays chunk after boot in host and sandbox"
```

- [ ] **Step 2: Functional suite**

```bash
lsof -ti tcp:5173 | xargs kill 2>/dev/null; true
VITE_NETWORKS=paseo-next-v2,previewnet bun run build
bun run --cwd apps/host test:functional
```

Run it with the Bash tool's `run_in_background: true`, output to a log in the scratchpad, and wait for it (it can take over 10 minutes).
Expected: 41 passed, 2 skipped (the same as before this sub-project), including "As a desktop user, I see a toast I can dismiss". A failure in a network-dependent test gets one re-run of only the failed tests; report both runs.

- [ ] **Step 3: Startup bundle and Solid checks**

On the Step 2 build:

```bash
bun scripts/eager-path-size.ts apps/host/dist
bun scripts/eager-path-size.ts apps/sandbox/dist
```

Then build the branch as it was before this sub-project in a temporary worktree and measure the same way (the "before" commit is the SP1 spec commit `31c67a34`):

```bash
git worktree add <scratchpad>/wt-sp1-base 31c67a34
cd <scratchpad>/wt-sp1-base && bun install --frozen-lockfile && VITE_NETWORKS=paseo-next-v2,previewnet bun run build
bun scripts/eager-path-size.ts apps/host/dist
bun scripts/eager-path-size.ts apps/sandbox/dist
```

Expected: host and sandbox `gz` each grow by at most 2,048 B versus the worktree numbers.

Check that no startup chunk contains Solid, using each sourcemap's `sources` (not its raw text), for every file in the `files` list the script printed:

```bash
python3 - <<'EOF'
import json, subprocess
for app in ("host", "sandbox"):
    files = json.loads(subprocess.check_output(["bun", "scripts/eager-path-size.ts", f"apps/{app}/dist"]))["files"]
    for f in files:
        sources = json.load(open(f"apps/{app}/dist/{f}.map"))["sources"]
        hits = [s for s in sources if "solid-js" in s or "@solidjs" in s or "/components/" in s]
        print(app, f, "SOLID" if hits else "ok", hits[:3])
EOF
```

Expected: every line ends in `ok []`. Then record the overlays chunk: find the chunk whose sourcemap `sources` contain `components/overlays/mount.tsx` in each app's `dist/assets`, and measure it with `wc -c` and `gzip -c <file> | wc -c`.

If the gate fails, stop and report the numbers and the chunks that grew; do not commit a pass.

- [ ] **Step 4: Cold-start A/B, 20 runs each**

Using the worktree from Step 3 as "before" and the branch as "after", follow the same procedure as the SP0 A/B (recorded in `docs/perf/solid-migration-baseline.md`, "Cold start A/B (20 runs each)"):

```bash
lsof -ti tcp:5173 | xargs kill 2>/dev/null; true
cd <scratchpad>/wt-sp1-base/apps/host
PERF_RUNS=20 PERF_SAVE_BASE=1 PERF_DOMAIN_A=browse PERF_DOMAIN_B=host-playground npx playwright test --config=tests/performance/playwright.config.ts tests/performance/cold-start.spec.ts
cp tests/performance/results/base.json <repo>/apps/host/tests/performance/results/base.json
cd <repo> && VITE_NETWORKS=paseo-next-v2,previewnet bun run build
lsof -ti tcp:5173 | xargs kill 2>/dev/null; true
cd apps/host
PERF_RUNS=20 PERF_DOMAIN_A=browse PERF_DOMAIN_B=host-playground npx playwright test --config=tests/performance/playwright.config.ts tests/performance/cold-start.spec.ts
bun tests/performance/compare.ts
```

Run each Playwright command in the background with a log. Expected: branch `Host total` p50 no more than 5% above the worktree's. Then remove the worktree: `git worktree remove --force <scratchpad>/wt-sp1-base`.

- [ ] **Step 5: Record the results**

Append to `docs/perf/solid-migration-baseline.md`:

```markdown
## After sub-project 1 (modals and toasts)

Overlays (toasts, permission, preimage, password and confirmation dialogs) are
Solid components in a lazily loaded chunk, prefetched when the browser is idle.
Measured on `feat/solid-v2-foundation` at `<HEAD short hash>` against the
branch before sub-project 1 (`31c67a34`), same build command, eager path via
`bun scripts/eager-path-size.ts`.

| Eager path | Before SP1 gzip | After SP1 gzip | Δ gzip | Gate (≤ +2 KB) |
|---|---:|---:|---:|---|
| host | <B> | <B> | <±B> | <pass/fail> |
| sandbox | <B> | <B> | <±B> | <pass/fail> |

Solid in startup chunks (sourcemap `sources`): <none / list>.

Overlays chunk: host `<file>` <raw> B raw / <gzip> B gzip; sandbox `<file>` <raw> B raw / <gzip> B gzip.

Cold start (20 runs each, back to back): before p50 <ms>, after p50 <ms>,
Δ <±x.x%>; `compare.ts` End-to-end <z>, <significant / not significant>.
Gate (no regression beyond 5%): **<pass / fail>**.
```

Fill every `<…>` with measured values.

```bash
git add docs/perf/solid-migration-baseline.md
git commit -m "docs(perf): record sub-project 1 sizes and cold start"
```

- [ ] **Step 6: e2e suite**

The umbrella asks for the `truapi` e2e suite before this sub-project is done. It needs the `host-playground` product repo checked out next to this repo (`../../../host-playground` from `apps/host`, see the root `test:e2e:local` script). Check: `ls ../host-playground 2>/dev/null || ls ../../host-playground 2>/dev/null`.
- If present: `bun run test:e2e:local` (background, with a log). Expected: same pass/skip counts as `main`; report them.
- If absent: do not attempt it. Report "e2e not run: host-playground not available locally" so the owner can run it.

- [ ] **Step 7: Final checks**

Run: `bun run typecheck && bun run lint && bun run test && bunx prettier --check $(git diff --name-only 31c67a34..HEAD -- '*.ts' '*.tsx')`
Expected: all pass.
