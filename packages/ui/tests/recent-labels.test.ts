// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadRecentLabels,
  recordRecentLabel,
  forgetRecentLabel,
} from "@dotli/ui/recent-labels";

// The recent list is written on `<label>.<root>` and read on the bare root,
// so the shared cross-subdomain store is authoritative and localStorage is
// only a mirror. The channel stands in for that store here.

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  readFails: false,
  writeFails: false,
  read: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
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
      mocks.clear(key);
      mocks.store.delete(key);
      return Promise.resolve();
    },
  }),
}));

const KEY = "dotli_recent";

function sharedList(): unknown {
  const raw = mocks.store.get(KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

function mirrorList(): unknown {
  const raw = localStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe("recent labels across subdomains", () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.readFails = false;
    mocks.writeFails = false;
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("reads the shared list rather than this origin's mirror", async () => {
    // Given: a list recorded by some other subdomain, plus a stale mirror
    mocks.store.set(KEY, '["explore","staking"]');
    localStorage.setItem(KEY, '["stale"]');

    // When / Then
    expect(await loadRecentLabels()).toEqual(["explore", "staking"]);
  });

  it("seeds the shared list from the mirror when no shared list exists yet", async () => {
    // Given: a device upgrading from the build that wrote only localStorage
    localStorage.setItem(KEY, '["explore","staking"]');

    // When
    const loaded = await loadRecentLabels();

    // Then
    expect(loaded).toEqual(["explore", "staking"]);
    expect(sharedList()).toEqual(["explore", "staking"]);
  });

  it("keeps an empty shared list empty rather than re-seeding removed labels", async () => {
    // Given: the user removed their last pill, and a stale mirror survives
    mocks.store.set(KEY, "[]");
    localStorage.setItem(KEY, '["removed"]');

    // When / Then
    expect(await loadRecentLabels()).toEqual([]);
    expect(mirrorList()).toEqual([]);
  });

  it("falls back to the mirror when the shared store is unreachable", async () => {
    // Given
    localStorage.setItem(KEY, '["explore"]');
    mocks.readFails = true;

    // When / Then
    expect(await loadRecentLabels()).toEqual(["explore"]);
  });

  it("merges a resolved label into the shared list instead of clobbering it", async () => {
    // Given: another subdomain already recorded a visit
    mocks.store.set(KEY, '["explore"]');

    // When
    await recordRecentLabel("staking");

    // Then
    expect(sharedList()).toEqual(["staking", "explore"]);
    expect(mirrorList()).toEqual(["staking", "explore"]);
  });

  it("moves a repeat visit to the front without duplicating it", async () => {
    // Given
    mocks.store.set(KEY, '["a","b","c"]');

    // When
    await recordRecentLabel("c");

    // Then
    expect(sharedList()).toEqual(["c", "a", "b"]);
  });

  it("ignores a label that can't be a .dot name", async () => {
    // When
    await recordRecentLabel("Not A Label");

    // Then
    expect(sharedList()).toBeUndefined();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("removes a label from the shared list and the mirror", async () => {
    // Given
    mocks.store.set(KEY, '["explore","typo-name"]');

    // When
    await forgetRecentLabel("typo-name");

    // Then
    expect(sharedList()).toEqual(["explore"]);
    expect(mirrorList()).toEqual(["explore"]);
  });

  it("keeps the mirror updated when the shared write fails", async () => {
    // Given
    mocks.store.set(KEY, '["explore"]');
    mocks.writeFails = true;

    // When
    await recordRecentLabel("staking");

    // Then: the shared store kept its old value, the mirror moved on
    expect(sharedList()).toEqual(["explore"]);
    expect(mirrorList()).toEqual(["staking", "explore"]);
  });

  it("caps the shared list at eight labels", async () => {
    // Given
    const eight = Array.from({ length: 8 }, (_, i) => `label${String(i)}`);
    mocks.store.set(KEY, JSON.stringify(eight));

    // When
    await recordRecentLabel("newest");

    // Then
    expect(sharedList()).toEqual(["newest", ...eight.slice(0, 7)]);
  });
});
