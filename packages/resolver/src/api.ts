// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Revive contract slots read straight from `chainHead_v1_storage`, with no runtime call or metadata.
// Like `ReviveApi::get_storage`, the `trie_id` comes from `AccountInfoOf` in the main trie, then the slot
// from that child trie. `trie_id` is never cached, because a redeploy would then return stale data.

import type { SubstrateClient } from '@polkadot-api/substrate-client';
import { OperationInaccessibleError, StopError } from '@polkadot-api/substrate-client';
import { Twox128, Blake2256, Hex } from '@polkadot-api/substrate-bindings';
import { fromHex, toHex, mergeUint8 } from '@polkadot-api/utils';

const enc = new TextEncoder();

const ACCOUNT_INFO_OF_PREFIX = mergeUint8([Twox128(enc.encode('Revive')), Twox128(enc.encode('AccountInfoOf'))]);

const decodeVecU8 = Hex().dec;

/**
 * A peer may never serve an old block's proof even while the head advances.
 * Retry the whole logical read at the current head, within one bounded window.
 */
const INACCESSIBLE_RETRY_DELAY_MS = 750;
const INACCESSIBLE_RETRY_WINDOW_MS = 30_000;

async function withInaccessibleRetry<T>(fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof OperationInaccessibleError) || performance.now() - started >= INACCESSIBLE_RETRY_WINDOW_MS) {
        throw err;
      }
    }
    await new Promise(resolve => setTimeout(resolve, INACCESSIBLE_RETRY_DELAY_MS));
  }
}

/** The chainHead follow stopped, so the caller must redial. Distinct from a `null` unset slot. */
export class ApiStoppedError extends Error {
  constructor(cause?: unknown) {
    super('chainHead follow stopped', { cause });
    this.name = 'ApiStoppedError';
  }
}

export interface Api {
  whenReady(): Promise<void>;
  /** Keeps each attempt pinned; an inaccessible read restarts in full at the current best block. */
  withBestBlock<T>(read: (hash: string) => Promise<T>): Promise<T>;
  /** Resolves `null` when the account is missing or not a contract. */
  resolveTrieId(contractAddress: string, atHash: string): Promise<Uint8Array | null>;
  /** Pass `atHash` and `trieId` to pin a multi-slot read to one block. Resolves `null` when unset. */
  readSlot(
    contractAddress: string,
    slotKey: `0x${string}`,
    atHash?: string,
    trieId?: Uint8Array,
  ): Promise<Uint8Array | null>;
  /** Fires at most once. */
  onStop(cb: () => void): () => void;
  /** Leaves the owning `SubstrateClient` alive. */
  destroy(): void;
}

/** Opens its own `chainHead` follow without runtime. The caller owns the client. */
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
      const wrapped = err instanceof ApiStoppedError ? err : new ApiStoppedError(err);
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

  // A server may stop a follow that lets pins pile up. Reads only target descendants of the newest finalized
  // block, so blocks finality leaves behind or prunes are unpinned, once the last read holding them ends.
  let newestFinalized: string | null = null;
  const holds = new Map<string, number>();
  const retiredWhileHeld = new Set<string>();

  function unpin(hashes: string[]): void {
    if (hashes.length === 0 || stopped) {
      return;
    }
    follow.unpin(hashes).catch(() => {
      /* the follow stopped, and its pins went with it */
    });
  }

  function retire(hashes: string[]): void {
    const free: string[] = [];
    for (const hash of hashes) {
      if (holds.has(hash)) {
        retiredWhileHeld.add(hash);
      } else {
        free.push(hash);
      }
    }
    unpin(free);
  }

  function release(hash: string): void {
    const count = (holds.get(hash) ?? 0) - 1;
    if (count > 0) {
      holds.set(hash, count);
      return;
    }
    holds.delete(hash);
    if (retiredWhileHeld.delete(hash)) {
      unpin([hash]);
    }
  }

  /** `hashes` are oldest first. Returns the blocks left behind. */
  function advanceFinalized(hashes: string[]): string[] {
    const newest = hashes.at(-1);
    if (newest === undefined) {
      return [];
    }
    const behind = newestFinalized === null ? hashes.slice(0, -1) : [newestFinalized, ...hashes.slice(0, -1)];
    newestFinalized = newest;
    return behind;
  }

  const follow = client.chainHead(
    false,
    event => {
      if (event.type === 'initialized') {
        bestHashRef = event.finalizedBlockHashes.at(-1) ?? null;
        retire(advanceFinalized(event.finalizedBlockHashes));
        resolveReady?.();
        resolveReady = null;
        rejectReady = null;
      } else if (event.type === 'bestBlockChanged') {
        bestHashRef = event.bestBlockHash;
      } else if (event.type === 'finalized') {
        retire([...advanceFinalized(event.finalizedBlockHashes), ...event.prunedBlockHashes]);
      }
    },
    err => {
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

  async function resolveTrieId(contractAddress: string, atHash: string): Promise<Uint8Array | null> {
    // `AccountInfoOf` uses the Identity hasher.
    const addr = fromHex(contractAddress);
    const mainKey = mergeUint8([ACCOUNT_INFO_OF_PREFIX, addr]);
    const accountInfoHex = await withStopGuard(() => follow.storage(atHash, 'value', toHex(mainKey), null));
    if (accountInfoHex === null) {
      return null;
    }
    const accountInfo = fromHex(accountInfoHex);
    // Tag 0x00 is `Contract(ContractInfo)`, whose first field is `trie_id` as a SCALE `Vec<u8>`.
    if (accountInfo[0] !== 0x00) {
      return null;
    }
    return fromHex(decodeVecU8(accountInfo.slice(1)));
  }

  async function withBestBlock<T>(read: (hash: string) => Promise<T>): Promise<T> {
    return withInaccessibleRetry(async () => {
      await ready;
      const hash = bestHashRef;
      if (hash === null || stopped) {
        throw new ApiStoppedError();
      }
      holds.set(hash, (holds.get(hash) ?? 0) + 1);
      try {
        return await read(hash);
      } finally {
        release(hash);
      }
    });
  }

  async function readSlotAt(
    contractAddress: string,
    slotKey: `0x${string}`,
    hash: string,
    trieId: Uint8Array | undefined,
  ): Promise<Uint8Array | null> {
    const trie = trieId ?? (await resolveTrieId(contractAddress, hash));
    if (trie === null) {
      return null;
    }
    const childKey = Blake2256(fromHex(slotKey));
    const valueHex = await withStopGuard(() => follow.storage(hash, 'value', toHex(childKey), toHex(trie)));
    return valueHex === null ? null : fromHex(valueHex);
  }

  return {
    whenReady: () => ready,
    withBestBlock,
    resolveTrieId,
    async readSlot(contractAddress, slotKey, atHash, trieId) {
      if (atHash === undefined) {
        return withBestBlock(hash => readSlotAt(contractAddress, slotKey, hash, trieId));
      }
      await ready;
      return readSlotAt(contractAddress, slotKey, atHash, trieId);
    },
    onStop(cb) {
      if (stopped) {
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
