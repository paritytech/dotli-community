// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_USER_KEY } from "@dotli/metrics/sentry";
import type { SharedChannel } from "@dotli/ui/shared-mode";

// The analytics id is minted per origin by `initSentry`, and every app is its
// own subdomain. The shared cross-subdomain store is what collapses those ids
// onto one, with localStorage kept as a mirror for boots that cannot reach it.

const state = {
  store: new Map<string, string>(),
  readFails: false,
  writeFails: false,
  read: vi.fn(),
  write: vi.fn(),
};

function fakeChannel(): SharedChannel {
  return {
    read: (key: string): Promise<string | null> => {
      state.read(key);
      return state.readFails
        ? Promise.reject(new Error("shared store unreachable"))
        : Promise.resolve(state.store.get(key) ?? null);
    },
    write: (key: string, value: string): Promise<void> => {
      state.write(key, value);
      if (state.writeFails) {
        return Promise.reject(new Error("shared store unreachable"));
      }
      state.store.set(key, value);
      return Promise.resolve();
    },
    clear: (key: string): Promise<void> => {
      state.store.delete(key);
      return Promise.resolve();
    },
  };
}

const KEY = ANALYTICS_USER_KEY;
const SHARED_ID = "11111111-1111-4111-8111-111111111111";
const LOCAL_ID = "22222222-2222-4222-8222-222222222222";

async function reconcile(): Promise<void> {
  const { reconcileAnalyticsUser } =
    await import("@dotli/ui/analytics-identity");
  await reconcileAnalyticsUser(fakeChannel());
}

describe("analytics identity across subdomains", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.store.clear();
    state.readFails = false;
    state.writeFails = false;
    localStorage.clear();
  });

  it("As a dotli user, visiting a second app reuses the id the first app recorded", async () => {
    // Given
    state.store.set(KEY, SHARED_ID);
    localStorage.setItem(KEY, LOCAL_ID);

    // When
    await reconcile();

    // Then
    expect(localStorage.getItem(KEY)).toBe(SHARED_ID);
  });

  it("As a dotli user, the first app to boot seeds the shared id for the rest", async () => {
    // Given
    localStorage.setItem(KEY, LOCAL_ID);

    // When
    await reconcile();

    // Then
    expect(state.store.get(KEY)).toBe(LOCAL_ID);
    expect(localStorage.getItem(KEY)).toBe(LOCAL_ID);
  });

  it("As a dotli user, an already matching id is not rewritten", async () => {
    // Given
    state.store.set(KEY, SHARED_ID);
    localStorage.setItem(KEY, SHARED_ID);

    // When
    await reconcile();

    // Then
    expect(state.write).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe(SHARED_ID);
  });

  it("As a dotli user on a blocked iframe, the per-origin id survives unchanged", async () => {
    // Given
    state.readFails = true;
    localStorage.setItem(KEY, LOCAL_ID);

    // When
    await reconcile();

    // Then
    // Falling back to a fresh id here would count the same browser twice.
    expect(localStorage.getItem(KEY)).toBe(LOCAL_ID);
  });

  it("As a dotli user, a failed shared write leaves the local id usable", async () => {
    // Given
    state.writeFails = true;
    localStorage.setItem(KEY, LOCAL_ID);

    // When
    await reconcile();

    // Then
    expect(localStorage.getItem(KEY)).toBe(LOCAL_ID);
  });

  it("As a dotli user on a build without analytics, nothing touches the shared store", async () => {
    // Given
    state.store.set(KEY, SHARED_ID);
    // No local id, which is what a metrics-stripped build or an unavailable
    // localStorage looks like.

    // When
    await reconcile();

    // Then
    expect(state.read).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("As a dotli user, reconciling twice only reads the shared store once", async () => {
    // Given
    state.store.set(KEY, SHARED_ID);
    localStorage.setItem(KEY, LOCAL_ID);
    const { reconcileAnalyticsUser } =
      await import("@dotli/ui/analytics-identity");

    // When
    await reconcileAnalyticsUser(fakeChannel());
    localStorage.setItem(KEY, LOCAL_ID);
    await reconcileAnalyticsUser(fakeChannel());

    // Then
    // The second call is a no-op, so it must not clobber the adopted id back.
    expect(localStorage.getItem(KEY)).toBe(LOCAL_ID);
  });
});
