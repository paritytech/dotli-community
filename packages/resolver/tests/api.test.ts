// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { createClient } from "@polkadot-api/substrate-client";
import type {
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from "@polkadot-api/json-rpc-provider";
import { toHex } from "@polkadot-api/utils";
import {
  createRawApi,
  ApiStoppedError,
  type Api,
  type ContractStorage,
} from "../src/api";
import {
  readMappingBytes,
  readNestedMappingString,
} from "../src/access-raw-storage";
import { PartialStorageReadError } from "../src/errors";
import { createChainBrokerManager } from "../../protocol/src/broker";

const ADDRESS = `0x${"11".repeat(20)}`;
const KEY = `0x${"22".repeat(32)}` as const;
const ACCOUNT = "0x0004aa"; // Contract, Vec<u8> trie_id = [0xaa].

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Exercise the installed substrate-client, including storage operation events,
// cancellation and unfollow. The server rejects use-after-unpin and records any
// unpin while an operation is still active; it is not a follow method mock.
function server(shared = false) {
  type Operation = { id: string; hash: string; child: unknown; key: string };
  type Chain = {
    token: string;
    pinned: Set<string>;
    operations: Map<string, Operation>;
    reads: Operation[];
    active: boolean;
  };
  const chains: Chain[] = [];
  const violations: string[] = [];
  let listener!: (message: JsonRpcMessage) => void;
  let counter = 0;
  let failUnpin = false;
  const waiters: Array<{ chain: Chain; count: number; resolve: () => void }> =
    [];
  function event(chain: Chain, result: Record<string, unknown>) {
    if (result.event === "initialized") {
      for (const hash of result.finalizedBlockHashes as string[])
        chain.pinned.add(hash);
    } else if (result.event === "newBlock") {
      chain.pinned.add(result.blockHash as string);
    } else if (result.event === "stop") {
      chain.active = false;
      chain.pinned.clear();
      chain.operations.clear();
    }
    listener({
      jsonrpc: "2.0",
      method: "chainHead_v1_followEvent",
      params: { subscription: chain.token, result },
    });
  }
  function reply(request: JsonRpcRequest, result: unknown) {
    listener({ jsonrpc: "2.0", id: request.id!, result });
  }
  const provider: JsonRpcProvider = (onMessage) => {
    listener = onMessage;
    return {
      send(request) {
        const params = request.params as unknown[];
        if (request.method === "chainHead_v1_follow") {
          const chain: Chain = {
            token: `follow-${chains.length}`,
            pinned: new Set(),
            operations: new Map(),
            reads: [],
            active: true,
          };
          chains.push(chain);
          queueMicrotask(() => reply(request, chain.token));
          return;
        }
        const chain = chains.find((entry) => entry.token === params[0])!;
        // Stale subscription releases are specified no-ops.
        if (
          chain === undefined &&
          (request.method === "chainHead_v1_unfollow" ||
            request.method === "chainHead_v1_unpin")
        )
          return;
        if (request.method === "chainHead_v1_unfollow") {
          chain.active = false;
          chain.pinned.clear();
          chain.operations.clear();
          return;
        }
        if (request.method === "chainHead_v1_unpin") {
          if (failUnpin) {
            failUnpin = false;
            queueMicrotask(() =>
              listener({
                jsonrpc: "2.0",
                id: request.id!,
                error: { code: -32801, message: "Unpin failed" },
              }),
            );
            return;
          }
          for (const hash of params[1] as string[]) {
            if (!chain.active || !chain.pinned.delete(hash))
              violations.push(`invalid unpin ${hash}`);
            if ([...chain.operations.values()].some((op) => op.hash === hash))
              violations.push(`active unpin ${hash}`);
          }
          queueMicrotask(() => reply(request, null));
          return;
        }
        if (request.method === "chainHead_v1_stopOperation") {
          chain.operations.delete(params[1] as string);
          return;
        }
        if (request.method !== "chainHead_v1_storage")
          throw new Error(String(request.method));
        const hash = params[1] as string;
        if (!chain.active || !chain.pinned.has(hash)) {
          listener({
            jsonrpc: "2.0",
            id: request.id!,
            error: { code: -32801, message: "Block not pinned" },
          });
          return;
        }
        const op = {
          id: `op-${counter++}`,
          hash,
          child: params[3],
          key: (params[2] as { key: string }[])[0]!.key,
        };
        chain.operations.set(op.id, op);
        chain.reads.push(op);
        queueMicrotask(() => {
          reply(request, {
            result: "started",
            operationId: op.id,
            discardedItems: 0,
          });
          for (let i = waiters.length - 1; i >= 0; i--) {
            const waiter = waiters[i]!;
            if (waiter.chain === chain && chain.reads.length >= waiter.count) {
              waiters.splice(i, 1);
              waiter.resolve();
            }
          }
        });
      },
      disconnect() {},
    };
  };
  const manager = shared ? createChainBrokerManager(() => provider) : null;
  const client = createClient(
    manager?.getLocalProvider("test-chain") ?? provider,
  );
  return {
    client,
    chains,
    violations,
    event,
    failNextUnpin() {
      failUnpin = true;
    },
    async join() {
      const api = createRawApi(client);
      await api.whenReady();
      return api;
    },
    async open(hashes = ["root"]) {
      const api = createRawApi(client);
      const chain = chains.at(-1)!;
      await Promise.resolve(); // deliver follow token before initialized
      event(chain, { event: "initialized", finalizedBlockHashes: hashes });
      await api.whenReady();
      return { api, chain };
    },
    waitReads(chain: Chain, count: number) {
      if (chain.reads.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) =>
        waiters.push({ chain, count, resolve }),
      );
    },
    complete(
      chain: Chain,
      index: number,
      value: string | null,
      error?: string,
    ) {
      const op = chain.reads[index]!;
      if (!chain.operations.delete(op.id))
        throw new Error("Operation already ended");
      if (!chain.pinned.has(op.hash))
        throw new Error("Storage block released before completion");
      if (error !== undefined) {
        event(chain, { event: "operationError", operationId: op.id, error });
      } else {
        if (value !== null)
          event(chain, {
            event: "operationStorageItems",
            operationId: op.id,
            items: [{ key: op.key, value }],
          });
        event(chain, { event: "operationStorageDone", operationId: op.id });
      }
    },
    advance(chain: Chain, hash: string, parent: string, pruned: string[] = []) {
      event(chain, {
        event: "newBlock",
        blockHash: hash,
        parentBlockHash: parent,
      });
      event(chain, { event: "bestBlockChanged", bestBlockHash: hash });
      event(chain, {
        event: "finalized",
        finalizedBlockHashes: [hash],
        prunedBlockHashes: pruned,
      });
    },
  };
}

function longSlot(length: number) {
  const bytes = new Uint8Array(32);
  bytes[31] = length * 2 + 1;
  return toHex(bytes);
}

describe("raw API block ownership", () => {
  it("bounds finalized history without reads", async () => {
    const h = server();
    const { api, chain } = await h.open(["ancestor", "root"]);
    for (let i = 1; i <= 100; i++) {
      h.advance(chain, `block-${i}`, i === 1 ? "root" : `block-${i - 1}`);
      await Promise.resolve();
    }
    expect([...chain.pinned]).toEqual(["block-100"]);
    expect(h.violations).toEqual([]);
    api.destroy();
    h.client.destroy();
  });

  it("keeps overlapping multi-slot reads consistent across best, finalization and pruning", async () => {
    const h = server();
    const { api, chain } = await h.open();
    h.event(chain, {
      event: "newBlock",
      blockHash: "fork",
      parentBlockHash: "root",
    });
    h.event(chain, { event: "bestBlockChanged", bestBlockHash: "fork" });
    const first = readMappingBytes(api, ADDRESS, KEY, 0);
    const second = readNestedMappingString(api, ADDRESS, KEY, "manifest", 0);
    await h.waitReads(chain, 2);
    h.advance(chain, "winner", "root", ["fork"]);
    await Promise.resolve();
    expect(chain.pinned.has("fork")).toBe(true);
    h.complete(chain, 0, ACCOUNT);
    h.complete(chain, 1, ACCOUNT);
    await h.waitReads(chain, 4);
    h.complete(chain, 2, longSlot(40));
    h.complete(chain, 3, longSlot(40));
    await h.waitReads(chain, 6);
    h.complete(chain, 4, toHex(new Uint8Array(32).fill(65)));
    await h.waitReads(chain, 7);
    h.complete(chain, 6, toHex(new Uint8Array(32).fill(66)));
    expect(await first).toEqual(
      new Uint8Array([
        ...new Uint8Array(32).fill(65),
        ...new Uint8Array(8).fill(66),
      ]),
    );
    expect(chain.pinned.has("fork")).toBe(true);
    h.complete(chain, 5, toHex(new Uint8Array(32).fill(67)));
    await h.waitReads(chain, 8);
    h.complete(chain, 7, toHex(new Uint8Array(32).fill(68)));
    expect(await second).toBe("C".repeat(32) + "D".repeat(8));
    expect(new Set(chain.reads.map((op) => op.hash))).toEqual(
      new Set(["fork"]),
    );
    expect([...chain.pinned]).toEqual(["winner"]);
    expect(h.violations).toEqual([]);
    api.destroy();
    h.client.destroy();
  });

  it("keeps non-best forks until pruning so a later best switch can read them", async () => {
    const h = server();
    const { api, chain } = await h.open();
    h.event(chain, {
      event: "newBlock",
      blockHash: "other",
      parentBlockHash: "root",
    });
    h.event(chain, {
      event: "newBlock",
      blockHash: "best",
      parentBlockHash: "root",
    });
    h.event(chain, { event: "bestBlockChanged", bestBlockHash: "best" });
    await Promise.resolve();
    h.event(chain, { event: "bestBlockChanged", bestBlockHash: "other" });
    const read = api.withContract(ADDRESS, (storage) => storage.readSlot(KEY));
    await h.waitReads(chain, 1);
    h.complete(chain, 0, ACCOUNT);
    await h.waitReads(chain, 2);
    h.complete(chain, 1, "0x1234");
    expect(await read).toEqual(new Uint8Array([0x12, 0x34]));
    expect(chain.reads[1]!.hash).toBe("other");
    expect(h.violations).toEqual([]);
    api.destroy();
    h.client.destroy();
  });

  it("releases missing contracts, failed storage and partial multi-slot reads", async () => {
    const h = server();
    const { api, chain } = await h.open();
    const missing = readMappingBytes(api, ADDRESS, KEY, 0);
    await h.waitReads(chain, 1);
    h.advance(chain, "next", "root");
    h.complete(chain, 0, null);
    expect(await missing).toBeNull();
    expect([...chain.pinned]).toEqual(["next"]);
    const failed = readMappingBytes(api, ADDRESS, KEY, 0);
    const rejected = expect(failed).rejects.toThrow("storage unavailable");
    await h.waitReads(chain, 2);
    h.advance(chain, "last", "next");
    h.complete(chain, 1, null, "storage unavailable");
    await rejected;
    expect([...chain.pinned]).toEqual(["last"]);
    const partial = readMappingBytes(api, ADDRESS, KEY, 0);
    const partialRejected = expect(partial).rejects.toBeInstanceOf(
      PartialStorageReadError,
    );
    await h.waitReads(chain, 3);
    h.complete(chain, 2, ACCOUNT);
    await h.waitReads(chain, 4);
    h.complete(chain, 3, longSlot(40));
    await h.waitReads(chain, 5);
    h.advance(chain, "tip", "last");
    h.complete(chain, 4, null);
    await partialRejected;
    expect([...chain.pinned]).toEqual(["tip"]);
    expect(h.violations).toEqual([]);
    api.destroy();
    h.client.destroy();
  });

  it("does not release an outstanding operation when its callback throws", async () => {
    const h = server();
    const { api, chain } = await h.open();
    let pending!: Promise<Uint8Array | null>;
    let escaped!: ContractStorage;
    const failure = new Error("consumer failed");
    const read = api.withContract(ADDRESS, async (storage) => {
      escaped = storage;
      pending = storage.readSlot(KEY);
      throw failure;
    });
    const rejected = expect(read).rejects.toBe(failure);
    await h.waitReads(chain, 1);
    h.complete(chain, 0, ACCOUNT);
    await h.waitReads(chain, 2);
    h.advance(chain, "next", "root");
    await rejected;
    expect(chain.pinned.has("root")).toBe(true);
    h.complete(chain, 1, "0x42");
    expect(await pending).toEqual(new Uint8Array([0x42]));
    expect([...chain.pinned]).toEqual(["next"]);
    await expect(escaped.readSlot(KEY)).rejects.toBeInstanceOf(Error);
    expect(chain.reads).toHaveLength(2);
    expect(h.violations).toEqual([]);
    api.destroy();
    h.client.destroy();
  });

  it("destroy cancels operations and callback waits; old continuations cannot touch a replacement", async () => {
    const h = server();
    const { api, chain } = await h.open();
    let stops = 0;
    api.onStop(() => {
      stops++;
      api.destroy();
    });
    const resume = deferred<void>();
    const entered = deferred<void>();
    let staleRead!: Promise<Uint8Array | null>;
    const waiting = api.withContract(ADDRESS, async (storage) => {
      entered.resolve();
      await resume.promise;
      staleRead = storage.readSlot(KEY);
      return staleRead;
    });
    const waitingRejected =
      expect(waiting).rejects.toBeInstanceOf(ApiStoppedError);
    await h.waitReads(chain, 1);
    h.complete(chain, 0, ACCOUNT);
    await entered.promise;
    const pending = readMappingBytes(api, ADDRESS, KEY, 0);
    const pendingRejected =
      expect(pending).rejects.toBeInstanceOf(ApiStoppedError);
    await h.waitReads(chain, 2);
    api.destroy();
    api.destroy();
    await waitingRejected;
    await pendingRejected;
    expect(stops).toBe(1);
    expect(chain.operations.size).toBe(0);
    await expect(api.whenReady()).rejects.toBeInstanceOf(ApiStoppedError);
    const replacement = await h.open(["replacement"]);
    resume.resolve();
    await Promise.resolve();
    await expect(staleRead).rejects.toBeInstanceOf(ApiStoppedError);
    const fresh = replacement.api.withContract(ADDRESS, (storage) =>
      storage.readSlot(KEY),
    );
    await h.waitReads(replacement.chain, 1);
    h.complete(replacement.chain, 0, ACCOUNT);
    await h.waitReads(replacement.chain, 2);
    h.complete(replacement.chain, 1, "0x99");
    expect(await fresh).toEqual(new Uint8Array([0x99]));
    expect(chain.reads).toHaveLength(2);
    expect(h.violations).toEqual([]);
    replacement.api.destroy();
    h.client.destroy();
  });

  it("normalizes server stop and rejects destroy before initialization", async () => {
    const h = server();
    const { api, chain } = await h.open();
    const read = readMappingBytes(api, ADDRESS, KEY, 0);
    const rejected = expect(read).rejects.toBeInstanceOf(ApiStoppedError);
    await h.waitReads(chain, 1);
    h.event(chain, { event: "stop" });
    await rejected;
    let lateStops = 0;
    api.onStop(() => {
      lateStops++;
    });
    api.destroy();
    expect(lateStops).toBe(1);
    const early = createRawApi(h.client);
    early.destroy();
    await expect(early.whenReady()).rejects.toBeInstanceOf(ApiStoppedError);
    await expect(
      early.withContract(ADDRESS, (storage) => storage.readSlot(KEY)),
    ).rejects.toBeInstanceOf(ApiStoppedError);
    h.client.destroy();
  });

  it.each([false, true])(
    "ends the generation if unpin fails (broker=%s)",
    async (shared) => {
      const h = server(shared);
      const { api, chain } = await h.open();
      h.failNextUnpin();
      h.advance(chain, "next", "root");
      const read = api.withContract(ADDRESS, (storage) =>
        storage.readSlot(KEY),
      );
      await expect(read).rejects.toBeInstanceOf(ApiStoppedError);
      expect(chain.active).toBe(false);
      expect(chain.operations.size).toBe(0);
      await expect(api.whenReady()).rejects.toBeInstanceOf(ApiStoppedError);
      h.client.destroy();
    },
  );

  it("keeps broker replay bounded and readable for a late follower on a non-best fork", async () => {
    const h = server(true);
    const { api, chain } = await h.open(["ancestor", "root"]);
    for (let i = 1; i <= 30; i++) {
      h.advance(chain, `b${i}`, i === 1 ? "root" : `b${i - 1}`);
      await Promise.resolve();
    }
    h.event(chain, {
      event: "newBlock",
      blockHash: "other",
      parentBlockHash: "b30",
    });
    h.event(chain, {
      event: "newBlock",
      blockHash: "best",
      parentBlockHash: "b30",
    });
    h.event(chain, { event: "bestBlockChanged", bestBlockHash: "best" });
    await Promise.resolve();
    expect(chain.pinned).toEqual(new Set(["b30", "other", "best"]));
    const late = await h.join();
    h.event(chain, { event: "bestBlockChanged", bestBlockHash: "other" });
    const read = late.withContract(ADDRESS, (storage) => storage.readSlot(KEY));
    await h.waitReads(chain, 1);
    h.complete(chain, 0, ACCOUNT);
    await h.waitReads(chain, 2);
    h.event(chain, { event: "bestBlockChanged", bestBlockHash: "best" });
    h.event(chain, {
      event: "finalized",
      finalizedBlockHashes: ["best"],
      prunedBlockHashes: ["other"],
    });
    await Promise.resolve();
    expect(chain.pinned.has("other")).toBe(true);
    h.complete(chain, 1, "0xabcd");
    expect(await read).toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.pinned).toEqual(new Set(["best"]));
    expect(h.violations).toEqual([]);
    late.destroy();
    api.destroy();
    h.client.destroy();
  });

  it("allows synchronous re-follow from a broker stop without reusing dead pins", async () => {
    const h = server(true);
    const { api, chain } = await h.open();
    let replacement!: Promise<Api>;
    api.onStop(() => {
      replacement = h.join();
    });
    h.event(chain, { event: "stop" });
    const next = h.chains.at(-1)!;
    expect(next).not.toBe(chain);
    await Promise.resolve();
    h.event(next, { event: "initialized", finalizedBlockHashes: ["root"] });
    const freshApi = await replacement;
    const read = freshApi.withContract(ADDRESS, (storage) =>
      storage.readSlot(KEY),
    );
    await h.waitReads(next, 1);
    h.complete(next, 0, ACCOUNT);
    await h.waitReads(next, 2);
    h.complete(next, 1, "0x42");
    expect(await read).toEqual(new Uint8Array([0x42]));
    expect(next.pinned).toEqual(new Set(["root"]));
    expect(h.violations).toEqual([]);
    freshApi.destroy();
    h.client.destroy();
  });
});
