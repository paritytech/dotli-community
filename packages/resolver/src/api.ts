// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Raw chainHead-backed contract-storage API.
//
// Reads a Revive contract slot via direct `chainHead_v1_storage` queries,
// no runtime call or metadata exchange involved.
//
// A slot is read in two steps, mirroring `ReviveApi::get_storage`:
//   1. read `Revive::AccountInfoOf[address]` from the MAIN trie, decode trie_id
//   2. read `blake2_256(slot)` from the contract's CHILD trie trie_id
//
// Callers pin both `bestHash` and `trie_id` once per logical multi-slot read
// (see `access-raw-storage.ts`). The API itself does NOT cache `trie_id`
// across calls, because a contract redeploy would silently return stale
// data otherwise.

import type { SubstrateClient } from "@polkadot-api/substrate-client";
import { StopError } from "@polkadot-api/substrate-client";
import { Twox128, Blake2256, Hex } from "@polkadot-api/substrate-bindings";
import { fromHex, toHex, mergeUint8 } from "@polkadot-api/utils";

const enc = new TextEncoder();

// Precomputed once: twox128("Revive") ++ twox128("AccountInfoOf").
const ACCOUNT_INFO_OF_PREFIX = mergeUint8([
  Twox128(enc.encode("Revive")),
  Twox128(enc.encode("AccountInfoOf")),
]);

/** SCALE `Vec<u8>` decoder (compact length + bytes), shared across calls. */
const decodeVecU8 = Hex().dec;

/**
 * Error thrown when an `Api` operation runs after the underlying chainHead
 * follow has stopped. Callers should treat this as "redial needed",
 * distinct from a `null` "slot not set" result.
 */
export class ApiStoppedError extends Error {
  constructor(cause?: unknown) {
    super("chainHead follow stopped", { cause });
    this.name = "ApiStoppedError";
  }
}

export interface Api {
  /**
   * Resolves once the chain head is initialized and a block is available.
   * Rejects with `ApiStoppedError` if the follow dies before then.
   */
  whenReady(): Promise<void>;
  /** Latest known best-block hash, or `null` before the first `initialized`. */
  bestHash(): string | null;
  /**
   * Walk `Revive::AccountInfoOf[contractAddress]` at `atHash`. Returns the
   * contract's child-trie id, or `null` if the account is missing or not a
   * Contract variant. Always queries the network. There is no cache.
   */
  resolveTrieId(
    contractAddress: string,
    atHash: string,
  ): Promise<Uint8Array | null>;
  /**
   * Read a 32-byte EVM storage slot of a Revive contract. Optional `atHash`
   * and `trieId` let callers pin a multi-slot read to a single block and trie
   * id (avoids torn reads when smoldot emits `bestBlockChanged` mid-loop).
   * `null` if unset.
   */
  readSlot(
    contractAddress: string,
    slotKey: `0x${string}`,
    atHash?: string,
    trieId?: Uint8Array,
  ): Promise<Uint8Array | null>;
  /**
   * Subscribe to the chainHead follow stopping. Fires at most once. Returns
   * an unsubscribe.
   */
  onStop(cb: () => void): () => void;
  /** Stop the chainHead follow. The owning `SubstrateClient` is NOT destroyed. */
  destroy(): void;
}

/**
 * Build an `Api` over an existing `SubstrateClient`. Opens its own
 * `chainHead` follow (`withRuntime: false`, no metadata fetch) and reads
 * from the best block. The caller owns the client's lifecycle.
 */
export function createRawApi(client: SubstrateClient): Api {
  let bestHashRef: string | null = null;
  let stopped = false;
  const stopCbs = new Set<() => void>();
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((err: unknown) => void) | null = null;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  function markStopped(err?: unknown): void {
    if (stopped) {
      return;
    }
    stopped = true;
    if (rejectReady !== null) {
      // Always wrap so callers can `instanceof ApiStoppedError` to
      // distinguish "follow died" from a transient network error inside an
      // operation. The original error is preserved as `cause`.
      const wrapped =
        err instanceof ApiStoppedError ? err : new ApiStoppedError(err);
      rejectReady(wrapped);
      rejectReady = null;
      resolveReady = null;
    }
    for (const cb of stopCbs) {
      try {
        cb();
        // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the others.
      } catch {
        /* ignore */
      }
    }
  }

  const follow = client.chainHead(
    false,
    (event) => {
      if (event.type === "initialized") {
        bestHashRef = event.finalizedBlockHashes.at(-1) ?? null;
        resolveReady?.();
        resolveReady = null;
        rejectReady = null;
      } else if (event.type === "bestBlockChanged") {
        bestHashRef = event.bestBlockHash;
      }
    },
    (err) => {
      markStopped(err);
    },
  );

  async function withStopGuard<T>(fn: () => Promise<T>): Promise<T> {
    if (stopped) {
      throw new ApiStoppedError();
    }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StopError) {
        markStopped(err);
        throw new ApiStoppedError(err);
      }
      throw err;
    }
  }

  async function resolveTrieId(
    contractAddress: string,
    atHash: string,
  ): Promise<Uint8Array | null> {
    const addr = fromHex(contractAddress); // 20-byte H160, Identity hasher
    const mainKey = mergeUint8([ACCOUNT_INFO_OF_PREFIX, addr]);
    const accountInfoHex = await withStopGuard(() =>
      follow.storage(atHash, "value", toHex(mainKey), null),
    );
    if (accountInfoHex === null) {
      return null;
    }
    const accountInfo = fromHex(accountInfoHex);
    // AccountInfo.account_type is an enum: tag 0x00 = Contract(ContractInfo).
    // ContractInfo.trie_id is its first field, a SCALE `Vec<u8>`.
    if (accountInfo[0] !== 0x00) {
      return null;
    }
    return fromHex(decodeVecU8(accountInfo.slice(1)));
  }

  return {
    whenReady: () => ready,
    bestHash: () => bestHashRef,
    resolveTrieId,
    async readSlot(contractAddress, slotKey, atHash, trieId) {
      await ready;
      const hash = atHash ?? bestHashRef;
      if (hash === null) {
        return null;
      }
      const trie = trieId ?? (await resolveTrieId(contractAddress, hash));
      if (trie === null) {
        return null;
      }
      const childKey = Blake2256(fromHex(slotKey)); // Key::Fix hash path
      const valueHex = await withStopGuard(() =>
        follow.storage(hash, "value", toHex(childKey), toHex(trie)),
      );
      return valueHex === null ? null : fromHex(valueHex);
    },
    onStop(cb) {
      if (stopped) {
        // Fire immediately for late subscribers, matching `onSmoldotFatal`.
        try {
          cb();
          // eslint-disable-next-line no-restricted-syntax -- defensive: one buggy late subscriber must not break the registration.
        } catch {
          /* ignore */
        }
        return () => {
          /* already stopped */
        };
      }
      stopCbs.add(cb);
      return () => {
        stopCbs.delete(cb);
      };
    },
    destroy() {
      try {
        follow.unfollow();
        // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: the follow may already be stopped.
      } catch {
        /* already stopped */
      }
    },
  };
}
