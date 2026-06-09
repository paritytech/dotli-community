// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Smoldot does not auto-persist. We pull each chain's finalized DB via the
// undocumented `chainHead_unstable_finalizedDatabase` RPC and save to IDB.
// `tapChain` demuxes our replies from external `getSmProvider` consumers
// that share the same response stream. The tap monkey-patches
// `nextJsonRpcResponse` / `remove` in place rather than returning a new
// object so smoldot's `WeakMap`-keyed identity check for
// `potentialRelayChains` keeps working.

import { log } from "@dotli/shared/log";

const DB_NAME = "dotli-smoldot-db";
const STORE = "chain-db";
const DB_VERSION = 1;
const MAX_DB_BYTES = 8_000_000;
// Real warp-sync blobs are hundreds of KB. Anything smaller is truncated
// or garbage and smoldot may hang on it instead of silently discarding.
const MIN_VALID_DB_BYTES = 100_000;
const IDB_TIMEOUT_MS = 3000;
const RPC_TIMEOUT_MS = 30_000;
const REQUEST_ID_PREFIX = "dotli-db-";

let reqCounter = 0;

interface SmoldotChainLike {
  sendJsonRpc(rpc: string): void;
  nextJsonRpcResponse(): Promise<string>;
  jsonRpcResponses: AsyncIterableIterator<string>;
  remove(): void;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("indexedDB.open failed"));
    };
  });
}

export async function loadChainDb(key: string): Promise<string | null> {
  if (!idbAvailable()) {
    return null;
  }
  const raw = await readRaw(key);
  if (raw === null) {
    return null;
  }
  if (raw.length < MIN_VALID_DB_BYTES) {
    log.warn(
      `[dot.li smoldot-db] Discarding undersized DB for "${key}" (${String(raw.length)} bytes < ${String(MIN_VALID_DB_BYTES)} floor)`,
    );
    return null;
  }
  return raw;
}

function readRaw(key: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      done(null);
    }, IDB_TIMEOUT_MS);

    openDb()
      .then((db) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => {
          const v: unknown = req.result;
          done(typeof v === "string" ? v : null);
          db.close();
        };
        req.onerror = () => {
          done(null);
          db.close();
        };
      })
      .catch((err: unknown) => {
        log.warn(
          `[dot.li smoldot-db] load failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        done(null);
      });
  });
}

// Returns `true` only when the blob was actually written. The
// `MIN_VALID_DB_BYTES` floor is enforced on BOTH save and load so we never
// persist a blob that the loader would later reject: a pre-warp-sync capture
// is just genesis and bootnodes (tiny), while a usable DB carries the `:code`
// runtime blob and is well over the floor. Keeping the gate symmetric avoids
// wasted writes and a cache that can never warm.
export async function saveChainDb(
  key: string,
  content: string,
): Promise<boolean> {
  if (!idbAvailable()) {
    return false;
  }
  if (content.length < MIN_VALID_DB_BYTES) {
    log.debug(
      `[dot.li smoldot-db] Skipping save for "${key}" (${String(content.length)} bytes < ${String(MIN_VALID_DB_BYTES)} floor)`,
    );
    return false;
  }
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(content, key);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error("put failed"));
        };
      });
      return true;
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn(
      `[dot.li smoldot-db] save failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export interface ChainDbTap {
  chain: SmoldotChainLike;
  extractDb(): Promise<string | null>;
  stop(): void;
  /**
   * `true` once the tap has been torn down via `stop()` or the wrapped
   * chain's `remove()`. Lets the persistence scheduler self-heal its timers
   * when the chain was removed through a path that didn't call `stop()`
   * directly (e.g. a `getSmProvider` disconnect).
   */
  isStopped(): boolean;
}

interface ExternalWaiter {
  resolve: (s: string) => void;
  reject: (e: unknown) => void;
}

export function tapChain(chain: SmoldotChainLike): ChainDbTap {
  const originalNext = chain.nextJsonRpcResponse.bind(chain);
  const originalRemove = chain.remove.bind(chain);

  const pendingExternal: ExternalWaiter[] = [];
  const bufferedResponses: string[] = [];
  const pendingDbRequests = new Map<string, (s: string | null) => void>();
  let stopped = false;

  function drainExternal(err: unknown): void {
    while (pendingExternal.length > 0) {
      const waiter = pendingExternal.shift();
      if (waiter !== undefined) {
        waiter.reject(err);
      }
    }
  }

  function teardown(reason: string): void {
    if (stopped) {
      return;
    }
    stopped = true;
    drainExternal(new Error(reason));
    for (const [id, resolver] of pendingDbRequests) {
      pendingDbRequests.delete(id);
      resolver(null);
    }
  }

  async function pump(): Promise<void> {
    while (!stopped) {
      let raw: string;
      try {
        raw = await originalNext();
      } catch (err: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated externally; flow analysis cannot see the cross-await change.
        if (!stopped) {
          drainExternal(err);
        }
        return;
      }
      if (typeof raw !== "string") {
        return;
      }
      try {
        const parsed = JSON.parse(raw) as { id?: unknown; result?: unknown };
        if (
          typeof parsed.id === "string" &&
          parsed.id.startsWith(REQUEST_ID_PREFIX)
        ) {
          const resolver = pendingDbRequests.get(parsed.id);
          if (resolver !== undefined) {
            pendingDbRequests.delete(parsed.id);
            resolver(typeof parsed.result === "string" ? parsed.result : null);
            continue;
          }
        }
        // eslint-disable-next-line no-restricted-syntax -- parse failures fall through to external forwarding.
      } catch {
        /* forward as-is */
      }

      const waiter = pendingExternal.shift();
      if (waiter !== undefined) {
        waiter.resolve(raw);
      } else {
        bufferedResponses.push(raw);
      }
    }
  }

  void pump();

  chain.nextJsonRpcResponse = (): Promise<string> => {
    const buf = bufferedResponses.shift();
    if (buf !== undefined) {
      return Promise.resolve(buf);
    }
    return new Promise<string>((resolve, reject) => {
      pendingExternal.push({ resolve, reject });
    });
  };

  chain.remove = (): void => {
    teardown("chain removed");
    try {
      originalRemove();
      // eslint-disable-next-line no-restricted-syntax -- underlying may already be dead; teardown above already drained consumers.
    } catch {
      /* already removed */
    }
  };

  async function extractDb(): Promise<string | null> {
    if (stopped) {
      return null;
    }
    reqCounter += 1;
    const id = `${REQUEST_ID_PREFIX}${String(reqCounter)}`;
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const settle = (value: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        pendingDbRequests.delete(id);
        clearTimeout(timer);
        resolve(value);
      };
      pendingDbRequests.set(id, settle);
      const timer = setTimeout(() => {
        settle(null);
      }, RPC_TIMEOUT_MS);
      try {
        chain.sendJsonRpc(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "chainHead_unstable_finalizedDatabase",
            params: [MAX_DB_BYTES],
          }),
        );
      } catch (err: unknown) {
        log.warn(
          `[dot.li smoldot-db] sendJsonRpc failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        settle(null);
      }
    });
  }

  function stop(): void {
    teardown("chain tap stopped");
  }

  return {
    chain,
    extractDb,
    stop,
    isStopped: () => stopped,
  };
}
