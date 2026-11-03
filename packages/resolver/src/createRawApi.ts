// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Revive contract slots read straight from `chainHead_v1_storage`, with no runtime call or metadata.
// Like `ReviveApi::get_storage`, the `trie_id` comes from `AccountInfoOf` in the main trie, then the slot
// from that child trie. `trie_id` is never cached, because a redeploy would then return stale data.

import type { SubstrateClient } from '@polkadot-api/substrate-client';
import {
  DisjointError,
  OperationInaccessibleError,
  OperationLimitError,
  StopError,
} from '@polkadot-api/substrate-client';
import { Twox128, Blake2256, Hex } from '@polkadot-api/substrate-bindings';
import { mergeUint8 } from '@polkadot-api/utils';
import { reportDefect, reportListener, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, createDeferred, createListenerSet, fromHex, toHex } from '@dotli/shared';
import { ApiStoppedError } from './apiStoppedError.js';

/** Raw contract storage reads over one chainHead follow. */
export type Api = {
  /** Settles once the follow reached its first block. Rejects with `ApiStoppedError` when it stops before that. */
  whenReady(): Promise<void>;
  /**
   * Keeps the best block pinned until `read` settles. Multi-call reads must go through here. Rejects with
   * `ApiStoppedError` once the follow stopped, and otherwise with `read`'s own error.
   */
  withBestBlock<T>(read: (hash: string) => Promise<T>): Promise<T>;
  /**
   * Resolves `null` when the account is missing or not a contract. Rejects with `ApiStoppedError` once the follow
   * stopped, and otherwise with the storage error, such as `OperationInaccessibleError` when no peer serves the read
   * within its retry window. A read the server refuses for its operation limit is retried within the same window, then
   * rejects with `OperationLimitError`.
   */
  resolveTrieId(contractAddress: string, atHash: string): Promise<Uint8Array | null>;
  /**
   * Pass `atHash` and `trieId` to pin a multi-slot read to one block. Resolves `null` when unset. Rejects with
   * `ApiStoppedError` once the follow stopped, and otherwise with the storage error, such as
   * `OperationInaccessibleError` when no peer serves the read within its retry window. A read the server refuses for its
   * operation limit is retried within the same window, then rejects with `OperationLimitError`.
   */
  readSlot(
    contractAddress: string,
    slotKey: `0x${string}`,
    options?: { atHash?: string; trieId?: Uint8Array },
  ): Promise<Uint8Array | null>;
  /** Calls `callback` once the follow stops, at once if it already has. Fires at most once. Returns the unsubscribe. */
  onStop(callback: () => void): () => void;
  /** Ends the follow and never throws. Leaves the owning `SubstrateClient` alive. */
  destroy(): void;
};

type ReadStorageParams = { hash: string; key: string; childTrie: string | null };

type Params = {
  client: SubstrateClient;
  /** The clock a read's retry window is measured on. */
  now?: () => number;
};

const encoder = new TextEncoder();

const ACCOUNT_INFO_OF_PREFIX = mergeUint8([
  Twox128(encoder.encode('Revive')),
  Twox128(encoder.encode('AccountInfoOf')),
]);

const decodeVecU8 = Hex().dec;

const RETRY_WINDOW_MS = 30_000;

// A server refuses operations past its per-follow limit, so each follow stays well under a common one.
const MAX_STORAGE_OPERATIONS = 8;

// Failures past a read's window, which end its retries.
const pastWindow = new WeakSet();

/**
 * A light client answers `operationInaccessible` just after syncing, before any peer served the proof. The raw client
 * does not retry it as papi's observable client does. A server also refuses an operation while its follow has too many
 * running. A read retries for 30 s from when it is asked for, queueing for an operation slot included, so a read no peer
 * serves fails however long each attempt takes.
 */
const retriedReads = createAsyncTaskPool({
  poolSize: Infinity,
  retryCount: Number.POSITIVE_INFINITY,
  retryDelay: 750,
  retryIf: error => isRetried(error) && !pastWindow.has(error),
});

/** Opens its own `chainHead` follow without runtime. The caller owns the client. */
export function createRawApi({ client, now = () => performance.now() }: Params): Api {
  let bestHashRef: string | null = null;
  let stopped = false;
  const stops = createListenerSet<undefined>({ onListenerError: reportListener('resolve', 'resolver.stop') });
  const ready = createDeferred<undefined>();
  const operations = createAsyncTaskPool({ poolSize: MAX_STORAGE_OPERATIONS });

  function markStopped(error?: unknown): void {
    if (stopped) {
      return;
    }
    stopped = true;
    // Rejecting is a no-op once the follow is ready.
    ready.reject(error instanceof ApiStoppedError ? error : new ApiStoppedError(error));
    stops.emit(undefined);
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
    follow.unpin(hashes).catch((error: unknown) => {
      // The follow stopped, and its pins went with it.
      if (error instanceof DisjointError) {
        return;
      }
      reportDefect(error, {
        flow: 'resolve',
        step: 'unpin',
        metric: S.RESOLVE_UNPIN,
        message: '[dot.li resolver] the light client refused an unpin:',
      });
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
        ready.resolve(undefined);
      } else if (event.type === 'bestBlockChanged') {
        bestHashRef = event.bestBlockHash;
      } else if (event.type === 'finalized') {
        retire([...advanceFinalized(event.finalizedBlockHashes), ...event.prunedBlockHashes]);
      }
    },
    error => {
      markStopped(error);
    },
  );

  async function withStopGuard<T>(work: () => Promise<T>): Promise<T> {
    if (stopped) {
      throw new ApiStoppedError();
    }
    try {
      return await work();
    } catch (error) {
      if (error instanceof StopError) {
        markStopped(error);
        throw new ApiStoppedError(error);
      }
      throw error;
    }
  }

  // Each attempt queues on its own, so a retry wait holds no operation slot.
  function readStorage({ hash, key, childTrie }: ReadStorageParams): Promise<string | null> {
    return readWithRetry(
      () => operations.call(() => withStopGuard(() => follow.storage(hash, 'value', key, childTrie))),
      now,
    );
  }

  async function resolveTrieId(contractAddress: string, atHash: string): Promise<Uint8Array | null> {
    // `AccountInfoOf` uses the Identity hasher.
    const address = fromHex(contractAddress);
    const mainKey = mergeUint8([ACCOUNT_INFO_OF_PREFIX, address]);
    const accountInfoHex = await readStorage({ hash: atHash, key: toHex(mainKey), childTrie: null });
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
    await ready.promise;
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

  async function readSlotAt({
    contractAddress,
    slotKey,
    hash,
    trieId,
  }: {
    contractAddress: string;
    slotKey: `0x${string}`;
    hash: string;
    trieId: Uint8Array | undefined;
  }): Promise<Uint8Array | null> {
    const trie = trieId ?? (await resolveTrieId(contractAddress, hash));
    if (trie === null) {
      return null;
    }
    const childKey = Blake2256(fromHex(slotKey));
    const valueHex = await readStorage({ hash, key: toHex(childKey), childTrie: toHex(trie) });
    return valueHex === null ? null : fromHex(valueHex);
  }

  return {
    whenReady: () => ready.promise,
    withBestBlock,
    resolveTrieId,
    async readSlot(contractAddress, slotKey, { atHash, trieId } = {}) {
      if (atHash === undefined) {
        return withBestBlock(hash => readSlotAt({ contractAddress, slotKey, hash, trieId }));
      }
      await ready.promise;
      return readSlotAt({ contractAddress, slotKey, hash: atHash, trieId });
    },
    onStop(callback) {
      if (stopped) {
        stops.deliver(callback, undefined);
        return () => {
          /* already stopped */
        };
      }
      return stops.subscribe(callback);
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

function readWithRetry<T>(read: () => Promise<T>, now: () => number): Promise<T> {
  const started = now();
  return retriedReads.call(async () => {
    try {
      return await read();
    } catch (error) {
      if (isRetried(error) && now() - started >= RETRY_WINDOW_MS) {
        pastWindow.add(error);
      }
      throw error;
    }
  });
}

function isRetried(error: unknown): error is OperationInaccessibleError | OperationLimitError {
  return error instanceof OperationInaccessibleError || error instanceof OperationLimitError;
}
