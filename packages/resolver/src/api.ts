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
 * A light client answers `operationInaccessible` just after syncing, before any peer served the proof.
 * The raw client does not retry it as papi's observable client does. The window lets a read no peer serves fail.
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
  /** Rejects with `ApiStoppedError` once the follow stops, even after it was ready. */
  whenReady(): Promise<void>;
  /** Keeps the best block pinned until `read` settles. Multi-call reads must go through here. */
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
  /** Fires once, on a stop or `destroy`; a late subscriber fires at once. */
  onStop(cb: () => void): () => void;
  /** Ends this follow, failing its outstanding reads with `ApiStoppedError`. Leaves the owning `SubstrateClient` alive. */
  destroy(): void;
}

/** Opens its own `chainHead` follow without runtime. The caller owns the client. */
export function createRawApi(client: SubstrateClient): Api {
  let bestHashRef: string | null = null;
  let stopped: ApiStoppedError | null = null;
  const stopCbs = new Set<() => void>();
  /** Settles every read in flight, since an operation on a dead transport may never answer. */
  const inFlight = new Set<(err: ApiStoppedError) => void>();
  let resolveReady!: () => void;
  let rejectReady!: (err: ApiStoppedError) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A follow destroyed before anyone awaits it must not surface as an unhandled rejection.
  void ready.catch(() => undefined);

  function terminate(err?: unknown): void {
    if (stopped !== null) {
      return;
    }
    stopped = err instanceof ApiStoppedError ? err : new ApiStoppedError(err);
    rejectReady(stopped);
    for (const reject of inFlight) {
      reject(stopped);
    }
    inFlight.clear();
    try {
      follow.unfollow();
      // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: the follow may already be stopped.
    } catch {
      /* already stopped */
    }
    for (const cb of stopCbs) {
      try {
        cb();
        // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the others.
      } catch {
        /* ignore */
      }
    }
    stopCbs.clear();
  }

  // A server may stop a follow that lets pins pile up. Reads only target descendants of the newest finalized
  // block, so blocks finality leaves behind or prunes are unpinned, once the last read holding them ends.
  let newestFinalized: string | null = null;
  const holds = new Map<string, number>();
  const retiredWhileHeld = new Set<string>();

  function unpin(hashes: string[]): void {
    if (hashes.length === 0 || stopped !== null) {
      return;
    }
    // A refused unpin leaves blocks pinned that nothing will release, so the follow ends and its owner redials.
    follow.unpin(hashes).catch(terminate);
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
        if (bestHashRef === null) {
          terminate();
          return;
        }
        retire(advanceFinalized(event.finalizedBlockHashes));
        resolveReady();
      } else if (event.type === 'bestBlockChanged') {
        bestHashRef = event.bestBlockHash;
      } else if (event.type === 'finalized') {
        retire([...advanceFinalized(event.finalizedBlockHashes), ...event.prunedBlockHashes]);
      }
    },
    terminate,
  );

  function withStopGuard<T>(fn: () => Promise<T>): Promise<T> {
    if (stopped !== null) {
      return Promise.reject(stopped);
    }
    return new Promise<T>((resolve, reject) => {
      inFlight.add(reject);
      void new Promise<T>(run => {
        run(fn());
      })
        .then(resolve, (err: unknown) => {
          if (err instanceof StopError) {
            terminate(err);
          }
          // After a stop, papi's own rejection (a `DisjointError` once unfollowed) means the same thing.
          reject(stopped ?? (err instanceof Error ? err : new Error('Storage read failed', { cause: err })));
        })
        .finally(() => inFlight.delete(reject));
    });
  }

  async function resolveTrieId(contractAddress: string, atHash: string): Promise<Uint8Array | null> {
    // `AccountInfoOf` uses the Identity hasher.
    const addr = fromHex(contractAddress);
    const mainKey = mergeUint8([ACCOUNT_INFO_OF_PREFIX, addr]);
    const accountInfoHex = await withInaccessibleRetry(() =>
      withStopGuard(() => follow.storage(atHash, 'value', toHex(mainKey), null)),
    );
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
    const valueHex = await withInaccessibleRetry(() =>
      withStopGuard(() => follow.storage(hash, 'value', toHex(childKey), toHex(trie))),
    );
    return valueHex === null ? null : fromHex(valueHex);
  }

  return {
    whenReady: () => (stopped === null ? ready : Promise.reject(stopped)),
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
    destroy: () => {
      terminate();
    },
  };
}
