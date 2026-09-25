// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Raw chainHead-backed contract storage, without runtime calls or metadata.
// A logical read owns one best block across AccountInfoOf and every child slot.
// Only current fork references and outstanding reads retain finalized history.

import type {
  FollowResponse,
  SubstrateClient,
} from "@polkadot-api/substrate-client";
import { StopError } from "@polkadot-api/substrate-client";
import { Twox128, Blake2256, Hex } from "@polkadot-api/substrate-bindings";
import { fromHex, toHex, mergeUint8 } from "@polkadot-api/utils";

const enc = new TextEncoder();
const ACCOUNT_INFO_OF_PREFIX = mergeUint8([
  Twox128(enc.encode("Revive")),
  Twox128(enc.encode("AccountInfoOf")),
]);
const decodeVecU8 = Hex().dec;

/** A dead API generation; the existing resolver owner must redial. */
export class ApiStoppedError extends Error {
  constructor(cause?: unknown) {
    super("chainHead follow stopped", { cause });
    this.name = "ApiStoppedError";
  }
}

/** Valid only inside the withContract callback, at one block and child trie. */
export interface ContractStorage {
  readSlot(slotKey: `0x${string}`): Promise<Uint8Array | null>;
}

export interface Api {
  /** Rejects with ApiStoppedError if initialization or the generation stops. */
  whenReady(): Promise<void>;
  /**
   * Retain the best block before the first await, resolve the contract trie
   * afresh, and release on callback completion/error. Missing contracts return
   * null without invoking read. A stopped generation rejects outstanding reads.
   */
  withContract<T>(
    contractAddress: string,
    read: (storage: ContractStorage) => Promise<T>,
  ): Promise<T | null>;
  /** Fires once, including explicit destroy; late subscribers fire immediately. */
  onStop(cb: () => void): () => void;
  /** End this generation, not the caller-owned SubstrateClient. Idempotent. */
  destroy(): void;
}

interface Pin {
  readers: number;
}

export function createRawApi(client: SubstrateClient): Api {
  let follow: FollowResponse | undefined = undefined;
  let bestHash: string | null = null;
  let finalizedHash: string | null = null;
  let stopped: ApiStoppedError | null = null;
  const pins = new Map<string, Pin>();
  const obsolete = new Set<string>();
  const stopCbs = new Set<() => void>();
  const pending = new Set<(error: ApiStoppedError) => void>();
  const operations = new AbortController();
  let resolveReady!: () => void;
  let rejectReady!: (error: ApiStoppedError) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Owners can destroy before anyone asks for readiness.
  void ready.catch(() => {
    // Rejection remains observable through whenReady().
  });

  function terminate(cause?: unknown): void {
    if (stopped !== null) {
      return;
    }
    stopped =
      cause instanceof ApiStoppedError ? cause : new ApiStoppedError(cause);
    bestHash = finalizedHash = null;
    rejectReady(stopped);
    for (const reject of pending) {
      reject(stopped);
    }
    pending.clear();
    // substrate-client unfollow rejects operations with DisjointError and does
    // not call onFollowError. Set our state first and explicitly cancel reads.
    operations.abort(stopped);
    pins.clear();
    obsolete.clear();
    try {
      follow?.unfollow();
      // eslint-disable-next-line no-restricted-syntax -- teardown can race an already-dead transport.
    } catch {
      /* the generation is already closed */
    }
    for (const cb of stopCbs) {
      try {
        cb();
        // eslint-disable-next-line no-restricted-syntax -- one subscriber must not block the other owners.
      } catch {
        /* continue notifying */
      }
    }
    stopCbs.clear();
  }

  // Queue once per event turn: synchronous provider initialization can precede
  // chainHead's return, and release() can run while handling a follow event.
  let releaseQueued = false;
  function releaseObsolete(): void {
    if (releaseQueued || stopped !== null) {
      return;
    }
    releaseQueued = true;
    queueMicrotask(() => {
      releaseQueued = false;
      if (stopped !== null || follow === undefined) {
        return;
      }
      const hashes: string[] = [];
      for (const hash of obsolete) {
        if (hash === bestHash || hash === finalizedHash) {
          continue;
        }
        if (pins.get(hash)?.readers !== 0) {
          continue;
        }
        obsolete.delete(hash);
        pins.delete(hash);
        hashes.push(hash);
      }
      if (hashes.length === 0) {
        return;
      }
      // A failed batch releases no blocks. End this follow rather than retain
      // its history indefinitely; the existing reconnect owner recreates it.
      try {
        void follow.unpin(hashes).catch(terminate);
      } catch (error) {
        terminate(error);
      }
    });
  }

  follow = client.chainHead(
    false,
    (event) => {
      if (stopped !== null) {
        return;
      }
      switch (event.type) {
        case "initialized":
          for (const hash of event.finalizedBlockHashes) {
            pins.set(hash, { readers: 0 });
            obsolete.add(hash);
          }
          bestHash = finalizedHash = event.finalizedBlockHashes.at(-1) ?? null;
          if (bestHash === null) {
            terminate();
            return;
          }
          resolveReady();
          break;
        case "newBlock":
          pins.set(event.blockHash, { readers: 0 });
          break;
        case "bestBlockChanged":
          bestHash = event.bestBlockHash;
          break;
        case "finalized":
          if (finalizedHash !== null) {
            obsolete.add(finalizedHash);
          }
          finalizedHash = event.finalizedBlockHashes.at(-1) ?? finalizedHash;
          for (const hash of event.finalizedBlockHashes) {
            obsolete.add(hash);
          }
          for (const hash of event.prunedBlockHashes) {
            obsolete.add(hash);
          }
          break;
      }
      releaseObsolete();
    },
    terminate,
  );
  if (operations.signal.aborted) {
    follow.unfollow();
  }

  function guard<T>(fn: () => Promise<T>): Promise<T> {
    if (stopped !== null) {
      return Promise.reject(stopped);
    }
    return new Promise<T>((resolve, reject) => {
      pending.add(reject);
      let result: Promise<T>;
      try {
        result = fn();
      } catch (error) {
        pending.delete(reject);
        reject(
          error instanceof Error
            ? error
            : new Error("Contract storage read failed", { cause: error }),
        );
        return;
      }
      result
        .then(resolve, (error: unknown) => {
          if (error instanceof StopError) {
            terminate(error);
          }
          reject(
            stopped ??
              (error instanceof Error
                ? error
                : new Error("Contract storage read failed", { cause: error })),
          );
        })
        .finally(() => pending.delete(reject));
    });
  }

  async function storage(
    hash: string,
    pin: Pin,
    key: string,
    trie: string | null,
  ): Promise<string | null> {
    // An operation also owns a reference: even if a callback throws without
    // awaiting its last read, unpin must wait for that operation to settle.
    pin.readers++;
    try {
      const activeFollow = follow;
      if (activeFollow === undefined) {
        const error = new ApiStoppedError();
        terminate(error);
        throw error;
      }
      return await guard(() =>
        activeFollow.storage(hash, "value", key, trie, operations.signal),
      );
    } finally {
      pin.readers--;
      releaseObsolete();
    }
  }

  return {
    whenReady: () => (stopped === null ? ready : Promise.reject(stopped)),
    async withContract(contractAddress, read) {
      operations.signal.throwIfAborted();
      if (bestHash === null) {
        await ready;
      }
      operations.signal.throwIfAborted();
      const hash = bestHash;
      const pin = hash === null ? undefined : pins.get(hash);
      if (hash === null || pin === undefined) {
        const error = new ApiStoppedError();
        terminate(error);
        throw error;
      }
      pin.readers++;
      let active = true;
      try {
        const mainKey = toHex(
          mergeUint8([ACCOUNT_INFO_OF_PREFIX, fromHex(contractAddress)]),
        );
        const accountHex = await storage(hash, pin, mainKey, null);
        operations.signal.throwIfAborted();
        if (accountHex === null) {
          return null;
        }
        const account = fromHex(accountHex);
        // AccountInfo.account_type: Contract tag 0, then SCALE Vec<u8> trie_id.
        if (account[0] !== 0) {
          return null;
        }
        const trie = decodeVecU8(account.slice(1));
        const result = await guard(() =>
          read({
            async readSlot(slotKey) {
              operations.signal.throwIfAborted();
              if (!active) {
                throw new Error("Contract storage scope has ended");
              }
              const key = toHex(Blake2256(fromHex(slotKey)));
              const value = await storage(hash, pin, key, trie);
              operations.signal.throwIfAborted();
              return value === null ? null : fromHex(value);
            },
          }),
        );
        operations.signal.throwIfAborted();
        return result;
      } finally {
        active = false;
        pin.readers--;
        releaseObsolete();
      }
    },
    onStop(cb) {
      if (stopped !== null) {
        try {
          cb();
          // eslint-disable-next-line no-restricted-syntax -- late listeners follow the same defensive notification contract.
        } catch {
          /* already stopped */
        }
        return () => {
          // Already stopped; no subscription was registered.
        };
      }
      stopCbs.add(cb);
      return () => {
        stopCbs.delete(cb);
      };
    },
    destroy: terminate,
  };
}
