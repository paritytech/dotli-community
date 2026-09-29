// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearBlockCache,
  deleteCachedBlock,
  getCachedBlock,
  pruneBlockCache,
  putCachedBlock,
} from "@dotli/storage/block-cache";
import { getDb } from "@dotli/storage/db";

describe("block cache", () => {
  beforeEach(async () => {
    await clearBlockCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a user, a block the host fetched before comes back on the next load", async () => {
    // Given
    await putCachedBlock("bafyA", new Uint8Array([1, 2, 3]));

    // When
    const bytes = await getCachedBlock("bafyA");

    // Then
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("As a user, a block the host never fetched is a miss rather than an error", async () => {
    // When
    const bytes = await getCachedBlock("bafyNever");

    // Then
    expect(bytes).toBeNull();
  });

  it("As a user, a block the relay found corrupted is gone once deleted", async () => {
    // Given
    await putCachedBlock("bafyBad", new Uint8Array([9]));

    // When
    await deleteCachedBlock("bafyBad");

    // Then
    expect(await getCachedBlock("bafyBad")).toBeNull();
  });

  it("As a user whose cache outgrew its limit, the blocks I used longest ago go first", async () => {
    // Given three 3-byte blocks stored in order, and the oldest read again last
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    await putCachedBlock("bafyOld", new Uint8Array(3));
    vi.setSystemTime(2_000);
    await putCachedBlock("bafyStale", new Uint8Array(3));
    vi.setSystemTime(3_000);
    await putCachedBlock("bafyRecent", new Uint8Array(3));
    vi.setSystemTime(4_000);
    await getCachedBlock("bafyOld");

    // When the cache is pruned to room for two of them
    const evicted = await pruneBlockCache(6);

    // Then only the one nobody used since it was stored is dropped
    expect(evicted).toBe(1);
    expect(await getCachedBlock("bafyStale")).toBeNull();
    expect(await getCachedBlock("bafyOld")).not.toBeNull();
    expect(await getCachedBlock("bafyRecent")).not.toBeNull();
  });

  it("As a user who turns the archive cache off, nothing the host kept survives", async () => {
    // Given
    await putCachedBlock("bafyA", new Uint8Array([1]));
    await putCachedBlock("bafyB", new Uint8Array([2]));

    // When
    await clearBlockCache();

    // Then
    expect(await getCachedBlock("bafyA")).toBeNull();
    expect(await getCachedBlock("bafyB")).toBeNull();
  });

  it("As a user, a malformed cache entry is a miss rather than a hang", async () => {
    // Given a `blocks` record whose `bytes` field isn't a `Uint8Array`, with
    // a matching `block_meta` row so the entry otherwise looks valid — the
    // shape a corrupted write or a future schema change could leave behind
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["blocks", "block_meta"], "readwrite");
      tx.objectStore("blocks").put({
        cid: "bafyMalformed",
        bytes: "not-bytes",
      });
      tx.objectStore("block_meta").put({
        cid: "bafyMalformed",
        size: 9,
        lastUsed: Date.now(),
      });
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error("setup transaction failed"));
      };
    });

    // When
    const bytes = await getCachedBlock("bafyMalformed");

    // Then
    expect(bytes).toBeNull();
  });
});
