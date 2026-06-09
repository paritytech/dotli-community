// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  getRecentLabels,
  addRecentLabel,
  getCachedCid,
  getCachedCidResult,
  setCachedCid,
  evictCachedCid,
  recordRevalidateOutcome,
} from "@dotli/storage/cid-cache";
import { getDb } from "@dotli/storage/db";

// Recent labels live in localStorage (happy-dom). CIDs live in IndexedDB (fake-indexeddb).

describe("getRecentLabels", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns empty array when nothing stored", () => {
    expect(getRecentLabels()).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    localStorage.setItem("dotli_recent", "");
    expect(getRecentLabels()).toEqual([]);
  });

  it("returns stored labels", () => {
    localStorage.setItem("dotli_recent", '["myapp","test"]');
    expect(getRecentLabels()).toEqual(["myapp", "test"]);
  });

  it("limits to MAX_RECENT (8) entries", () => {
    const labels = Array.from({ length: 20 }, (_, i) => `label${i}`);
    localStorage.setItem("dotli_recent", JSON.stringify(labels));
    expect(getRecentLabels()).toHaveLength(8);
  });

  it("returns empty array for malformed JSON", () => {
    localStorage.setItem("dotli_recent", "not-json");
    expect(getRecentLabels()).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    localStorage.setItem("dotli_recent", '{"foo":"bar"}');
    expect(getRecentLabels()).toEqual([]);
  });
});

describe("addRecentLabel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("adds a label to empty list", async () => {
    await addRecentLabel("myapp");
    expect(getRecentLabels()).toEqual(["myapp"]);
  });

  it("prepends new label to front", async () => {
    localStorage.setItem("dotli_recent", '["old"]');
    await addRecentLabel("new");
    expect(getRecentLabels()).toEqual(["new", "old"]);
  });

  it("deduplicates existing label (moves to front)", async () => {
    localStorage.setItem("dotli_recent", '["a","b","c"]');
    await addRecentLabel("b");
    expect(getRecentLabels()).toEqual(["b", "a", "c"]);
  });

  it("limits to MAX_RECENT entries", async () => {
    const initial = Array.from({ length: 8 }, (_, i) => `label${i}`);
    localStorage.setItem("dotli_recent", JSON.stringify(initial));
    await addRecentLabel("new");
    const result = getRecentLabels();
    expect(result).toHaveLength(8);
    expect(result[0]).toBe("new");
    // Last item from initial should be evicted
    expect(result).not.toContain("label7");
  });

  it("returns a resolved promise", async () => {
    const result = addRecentLabel("test");
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});

async function clearCidStore(): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("cids", "readwrite");
    tx.objectStore("cids").clear();
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("clear failed"));
    };
  });
}

async function readRawEntry(
  label: string,
): Promise<{ label: string; cid: string; timestamp: number } | undefined> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("cids", "readonly");
    const req = tx.objectStore("cids").get(label);
    req.onsuccess = () => {
      resolve(
        req.result as
          | { label: string; cid: string; timestamp: number }
          | undefined,
      );
    };
    req.onerror = () => {
      reject(req.error ?? new Error("read failed"));
    };
  });
}

describe("CID IndexedDB round-trip", () => {
  beforeEach(async () => {
    await clearCidStore();
  });

  it("setCachedCid → getCachedCidResult returns hit", async () => {
    await setCachedCid("myapp", "bafy123");
    expect(await getCachedCidResult("myapp")).toEqual({
      kind: "hit",
      cid: "bafy123",
    });
  });

  it("getCachedCidResult returns miss for unset label", async () => {
    expect(await getCachedCidResult("never-stored")).toEqual({ kind: "miss" });
  });

  it("legacy getCachedCid collapses miss to null", async () => {
    expect(await getCachedCid("never-stored")).toBeNull();
  });

  it("legacy getCachedCid returns the cid on hit", async () => {
    await setCachedCid("myapp", "bafy456");
    expect(await getCachedCid("myapp")).toBe("bafy456");
  });

  it("setCachedCid overwrites the existing entry and refreshes timestamp", async () => {
    await setCachedCid("myapp", "bafy-old");
    const first = await readRawEntry("myapp");
    expect(first?.cid).toBe("bafy-old");

    // Force a measurable timestamp delta even on fast machines / coarse clocks.
    await new Promise((resolve) => setTimeout(resolve, 2));

    await setCachedCid("myapp", "bafy-new");
    const second = await readRawEntry("myapp");
    expect(second?.cid).toBe("bafy-new");
    expect(second?.timestamp ?? 0).toBeGreaterThan(first?.timestamp ?? 0);
  });
});

describe("recordRevalidateOutcome", () => {
  beforeEach(async () => {
    await clearCidStore();
  });

  it("returns 'match' and refreshes timestamp when fresh CID equals served", async () => {
    await setCachedCid("myapp", "bafy123");
    const before = await readRawEntry("myapp");
    await new Promise((resolve) => setTimeout(resolve, 2));

    const outcome = await recordRevalidateOutcome(
      "myapp",
      "bafy123",
      "bafy123",
    );
    expect(outcome).toEqual({ kind: "match" });

    const after = await readRawEntry("myapp");
    expect(after?.cid).toBe("bafy123");
    expect(after?.timestamp ?? 0).toBeGreaterThan(before?.timestamp ?? 0);
  });

  it("returns 'update' and writes the new CID when it differs", async () => {
    await setCachedCid("myapp", "bafy-old");

    const outcome = await recordRevalidateOutcome(
      "myapp",
      "bafy-old",
      "bafy-new",
    );
    expect(outcome).toEqual({ kind: "update", cid: "bafy-new" });
    expect(await getCachedCid("myapp")).toBe("bafy-new");
  });

  it("returns 'cleared' and evicts the cache entry when fresh is null", async () => {
    await setCachedCid("myapp", "bafy-served");
    expect(await getCachedCid("myapp")).toBe("bafy-served");

    const outcome = await recordRevalidateOutcome("myapp", "bafy-served", null);
    expect(outcome).toEqual({ kind: "cleared" });
    expect(await getCachedCidResult("myapp")).toEqual({ kind: "miss" });
  });
});

describe("evictCachedCid", () => {
  beforeEach(async () => {
    await clearCidStore();
  });

  it("removes an existing entry", async () => {
    await setCachedCid("myapp", "bafy-doomed");
    expect(await getCachedCid("myapp")).toBe("bafy-doomed");

    await evictCachedCid("myapp");
    expect(await getCachedCidResult("myapp")).toEqual({ kind: "miss" });
  });

  it("is a no-op for an unset label", async () => {
    await evictCachedCid("never-stored");
    expect(await getCachedCidResult("never-stored")).toEqual({ kind: "miss" });
  });
});
