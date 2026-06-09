// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadChainDb, saveChainDb, tapChain } from "@dotli/resolver/smoldot-db";

// `MIN_VALID_DB_BYTES` floor is 100_000. Use sizes either side of it.
const BIG = "x".repeat(200_000);
const SMALL = "x".repeat(1_000);
const DB_PREFIX = "dotli-db-";

/**
 * Controllable stand-in for a smoldot chain. `emit` delivers a response to
 * whatever `nextJsonRpcResponse` waiter the tap's pump has registered, or
 * buffers it until the pump asks again.
 */
function makeFakeChain() {
  const sent: string[] = [];
  const outQueue: string[] = [];
  let waiter: ((s: string) => void) | null = null;
  let removed = false;
  return {
    sent,
    get removed() {
      return removed;
    },
    sendJsonRpc(rpc: string): void {
      sent.push(rpc);
    },
    nextJsonRpcResponse(): Promise<string> {
      const buffered = outQueue.shift();
      if (buffered !== undefined) {
        return Promise.resolve(buffered);
      }
      return new Promise<string>((resolve) => {
        waiter = resolve;
      });
    },
    jsonRpcResponses: (async function* () {})(),
    remove(): void {
      removed = true;
    },
    emit(response: string): void {
      if (waiter !== null) {
        const w = waiter;
        waiter = null;
        w(response);
      } else {
        outQueue.push(response);
      }
    },
  };
}

// Let queued microtasks (pump loop hops) settle.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function lastSentId(fake: ReturnType<typeof makeFakeChain>): string {
  const parsed = JSON.parse(fake.sent[fake.sent.length - 1]) as { id: string };
  return parsed.id;
}

describe("saveChainDb / loadChainDb", () => {
  beforeEach(async () => {
    // fake-indexeddb persists across tests in the same worker, so drop our store.
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("dotli-smoldot-db");
      req.onsuccess = () => {
        resolve();
      };
      req.onerror = () => {
        resolve();
      };
      req.onblocked = () => {
        resolve();
      };
    });
  });

  it("round-trips a database blob above the size floor", async () => {
    const saved = await saveChainDb("net:relay", BIG);
    expect(saved).toBe(true);
    expect(await loadChainDb("net:relay")).toBe(BIG);
  });

  it("skips saving a blob below the size floor", async () => {
    const saved = await saveChainDb("net:relay", SMALL);
    expect(saved).toBe(false);
    expect(await loadChainDb("net:relay")).toBeNull();
  });

  it("returns null for an unknown key", async () => {
    expect(await loadChainDb("net:never-written")).toBeNull();
  });

  it("discards a previously stored blob that is now under the floor", async () => {
    // Simulate legacy/foreign data written below today's floor by writing the
    // raw value directly, bypassing saveChainDb's guard.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("dotli-smoldot-db", 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("chain-db");
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("chain-db", "readwrite");
        tx.objectStore("chain-db").put(SMALL, "net:legacy");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error("seed put failed"));
        };
      };
      open.onerror = () => {
        reject(open.error ?? new Error("seed open failed"));
      };
    });
    expect(await loadChainDb("net:legacy")).toBeNull();
  });
});

describe("tapChain demux", () => {
  it("resolves extractDb with the matching DB response", async () => {
    const fake = makeFakeChain();
    const tap = tapChain(fake);

    const pending = tap.extractDb();
    await flush();

    expect(fake.sent).toHaveLength(1);
    const sent = JSON.parse(fake.sent[0]) as { id: string; method: string };
    expect(sent.method).toBe("chainHead_unstable_finalizedDatabase");
    expect(sent.id.startsWith(DB_PREFIX)).toBe(true);

    fake.emit(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: BIG }));
    expect(await pending).toBe(BIG);
  });

  it("intercepts DB responses so external consumers never see them", async () => {
    const fake = makeFakeChain();
    const tap = tapChain(fake);

    const external = tap.chain.nextJsonRpcResponse();
    const pending = tap.extractDb();
    await flush();
    const dbId = lastSentId(fake);

    // The DB reply must be swallowed. The external reply must pass through.
    fake.emit(JSON.stringify({ jsonrpc: "2.0", id: dbId, result: BIG }));
    fake.emit(JSON.stringify({ jsonrpc: "2.0", id: 42, result: "external" }));

    expect(await pending).toBe(BIG);
    expect(await external).toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 42, result: "external" }),
    );
  });

  it("forwards non-DB responses to external consumers", async () => {
    const fake = makeFakeChain();
    const tap = tapChain(fake);

    const msg = JSON.stringify({ jsonrpc: "2.0", id: 7, result: "ok" });
    fake.emit(msg);
    await flush();

    expect(await tap.chain.nextJsonRpcResponse()).toBe(msg);
  });

  it("resolves extractDb with null on RPC timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeChain();
      const tap = tapChain(fake);
      const pending = tap.extractDb();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() rejects pending external waiters and flips isStopped", async () => {
    const fake = makeFakeChain();
    const tap = tapChain(fake);

    const external = tap.chain.nextJsonRpcResponse();
    tap.stop();

    expect(tap.isStopped()).toBe(true);
    await expect(external).rejects.toThrow("chain tap stopped");
  });

  it("remove() tears down the underlying chain and resolves pending DB requests", async () => {
    const fake = makeFakeChain();
    const tap = tapChain(fake);

    const dbPending = tap.extractDb();
    const external = tap.chain.nextJsonRpcResponse();
    await flush();

    tap.chain.remove();

    expect(fake.removed).toBe(true);
    expect(tap.isStopped()).toBe(true);
    expect(await dbPending).toBeNull();
    await expect(external).rejects.toThrow("chain removed");
  });

  it("extractDb returns null once stopped", async () => {
    const fake = makeFakeChain();
    const tap = tapChain(fake);
    tap.stop();
    expect(await tap.extractDb()).toBeNull();
  });
});
