// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// The analytics id is minted per origin by `initSentry`, and every app is its
// own subdomain. The shared cross-subdomain store is what collapses those ids
// onto one, with localStorage kept as a mirror for boots that cannot reach it.

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  readFails: false,
  writeFails: false,
  read: vi.fn(),
  write: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock("@dotli/ui/shared-mode", () => ({
  getSharedChannel: () => ({
    read: (key: string): Promise<string | null> => {
      mocks.read(key);
      return mocks.readFails
        ? Promise.reject(new Error("shared store unreachable"))
        : Promise.resolve(mocks.store.get(key) ?? null);
    },
    write: (key: string, value: string): Promise<void> => {
      mocks.write(key, value);
      if (mocks.writeFails) {
        return Promise.reject(new Error("shared store unreachable"));
      }
      mocks.store.set(key, value);
      return Promise.resolve();
    },
    clear: (key: string): Promise<void> => {
      mocks.store.delete(key);
      return Promise.resolve();
    },
  }),
}));

const KEY = "dotli:sentry-uuid";
const SHARED_ID = "11111111-1111-4111-8111-111111111111";
const LOCAL_ID = "22222222-2222-4222-8222-222222222222";

async function reconcile(): Promise<void> {
  const { reconcileAnalyticsUser } =
    await import("@dotli/ui/analytics-identity");
  await reconcileAnalyticsUser();
}

describe("analytics identity across subdomains", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.readFails = false;
    mocks.writeFails = false;
    localStorage.clear();
  });

  it("As a dotli user, visiting a second app reuses the id the first app recorded", async () => {
    // Given
    mocks.store.set(KEY, SHARED_ID);
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
    expect(mocks.store.get(KEY)).toBe(LOCAL_ID);
    expect(localStorage.getItem(KEY)).toBe(LOCAL_ID);
  });

  it("As a dotli user, an already matching id is not rewritten", async () => {
    // Given
    mocks.store.set(KEY, SHARED_ID);
    localStorage.setItem(KEY, SHARED_ID);

    // When
    await reconcile();

    // Then
    expect(mocks.write).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe(SHARED_ID);
  });

  it("As a dotli user on a blocked iframe, the per-origin id survives unchanged", async () => {
    // Given
    mocks.readFails = true;
    localStorage.setItem(KEY, LOCAL_ID);

    // When
    await reconcile();

    // Then
    // Falling back to a fresh id here would count the same browser twice.
    expect(localStorage.getItem(KEY)).toBe(LOCAL_ID);
  });

  it("As a dotli user, a failed shared write leaves the local id usable", async () => {
    // Given
    mocks.writeFails = true;
    localStorage.setItem(KEY, LOCAL_ID);

    // When
    await reconcile();

    // Then
    expect(localStorage.getItem(KEY)).toBe(LOCAL_ID);
  });

  it("As a dotli user on a build without analytics, nothing touches the shared store", async () => {
    // Given
    mocks.store.set(KEY, SHARED_ID);
    // No local id, which is what a metrics-stripped build or an unavailable
    // localStorage looks like.

    // When
    await reconcile();

    // Then
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("As a dotli user, reconciling twice only reads the shared store once", async () => {
    // Given
    mocks.store.set(KEY, SHARED_ID);
    localStorage.setItem(KEY, LOCAL_ID);
    const { reconcileAnalyticsUser } =
      await import("@dotli/ui/analytics-identity");

    // When
    await reconcileAnalyticsUser();
    localStorage.setItem(KEY, LOCAL_ID);
    await reconcileAnalyticsUser();

    // Then
    // The second call is a no-op, so it must not clobber the adopted id back.
    expect(localStorage.getItem(KEY)).toBe(LOCAL_ID);
  });
});
