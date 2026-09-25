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
