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
