// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("../../../metrics/src/sentry.js", () => sentry);

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
} from "../../src/state/toasts.js";

function input(overrides: Partial<ToastInput> = {}): ToastInput {
  return {
    text: "Body",
    label: "Title",
    icon: "<svg></svg>",
    dismissMs: 1000,
    ...overrides,
  };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
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
