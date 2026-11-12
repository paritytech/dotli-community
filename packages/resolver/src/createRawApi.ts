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
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  createStateMachine,
  fromHex,
  nest,
  toHex,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import { ApiStoppedError } from './apiStoppedError.js';

const report = createReporter({ flow: 'resolve' });

/** Count. An unpin the light client refused while the follow ran, so pins pile up. Tag `outcome` and `reason`. */
const resolveUnpinMetric = defineCount<'error'>('resolve.unpin');

/**
 * Count. A transition of the chainHead follow threw, a bug. Tagged `outcome` (error) and `reason` (the error's name).
 */
const rawApiTransitionMetric = defineCount<'error'>('resolve.raw_api_transition');

/** Raw contract storage reads over one chainHead follow. */
export type Api = {
  /**
   * Settles once the follow reached its first block. Rejects with `ApiStoppedError` once the follow stopped, before or
   * after that.
   */
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
  /**
   * Ends the follow as a stop, so `onStop` listeners fire and a pending `whenReady` rejects with `ApiStoppedError`.
   * Never throws. Leaves the owning `SubstrateClient` alive.
   */
  destroy(): void;
};

type ReadStorageParams = { hash: string; key: string; childTrie: string | null };

type Params = {
  client: SubstrateClient;
  /** The clock a read's retry window is measured on. */
  now?: () => number;
};

type Waiter = { resolve: () => void; reject: (error: ApiStoppedError) => void };

/** A block reads pin. A retired one is a block finality left behind while a read held it, unpinned once no read does. */
type Pin = { kind: 'held'; count: number } | { kind: 'retired'; count: number } | { kind: 'released' };

type HeldPin = Exclude<Pin, { kind: 'released' }>;

/** Where the follow stands. A ready follow keeps the best block, finality's newest block and the blocks reads hold. */
type FollowState =
  | { kind: 'following'; waiters: readonly Waiter[] }
  | { kind: 'ready'; bestHash: string; newestFinalized: string; pins: ReadonlyMap<string, HeldPin> }
  | { kind: 'stopped'; error: ApiStoppedError };

type FollowEvent =
  | { kind: 'waited'; waiter: Waiter }
  | { kind: 'initialized'; newest: string; older: readonly string[] }
  | { kind: 'bestBlockChanged'; hash: string }
  | { kind: 'finalized'; finalized: readonly string[]; pruned: readonly string[] }
  | { kind: 'blockHeld'; hash: string }
  | { kind: 'blockReleased'; hash: string }
  | { kind: 'blockRetired'; hash: string }
  | { kind: 'unpinned' }
  | { kind: 'unpinFailed'; error: unknown }
  | { kind: 'followEnded'; cause: unknown }
  | { kind: 'destroyed' };

type FollowEffect = { kind: 'unpinRefused'; error: unknown };

type FollowMachine = MachineTypes<FollowState, FollowEvent, FollowEffect>;

type PinMachine = MachineTypes<Pin, FollowEvent, FollowEffect>;

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
  const stops = createListenerSet<undefined>({ onListenerError: report.listener('resolver.stop') });
  const operations = createAsyncTaskPool({ poolSize: MAX_STORAGE_OPERATIONS });

  function unpin(hashes: readonly string[], update: Transition<FollowMachine>['update']): void {
    if (hashes.length === 0) {
      return;
    }
    update(
      follow.unpin([...hashes]).then(
        () => ({ kind: 'unpinned' }),
        (error: unknown) => ({ kind: 'unpinFailed', error }),
      ),
    );
  }

  function tellStopped(state: Exclude<FollowState, { kind: 'stopped' }>, error: ApiStoppedError): void {
    switch (state.kind) {
      case 'following':
        for (const { reject } of state.waiters) {
          reject(error);
        }
        break;
      case 'ready':
        break;
    }
    stops.emit(undefined);
  }

  const endFollow: HandlerOf<FollowMachine, 'following' | 'ready', 'followEnded'> = (
    state,
    { cause },
    { emitState },
  ) => {
    const error = new ApiStoppedError(cause);
    emitState({ kind: 'stopped', error });
    tellStopped(state, error);
  };

  const destroyFollow: HandlerOf<FollowMachine, 'following' | 'ready', 'destroyed'> = (
    state,
    _event,
    { emitState },
  ) => {
    const error = new ApiStoppedError();
    emitState({ kind: 'stopped', error });
    try {
      follow.unfollow();
      // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: the follow may already be stopped.
    } catch {
      /* already stopped */
    }
    // `unfollow` stops the follow without calling its error callback.
    tellStopped(state, error);
  };

  const releasePin = nest<FollowMachine, 'ready', PinMachine, 'blockReleased' | 'blockRetired'>({
    find: ({ pins }, { hash }) => pins.get(hash) ?? null,
    store(state, { hash }, next) {
      const pins = new Map(state.pins);
      switch (next.kind) {
        case 'held':
        case 'retired':
          pins.set(hash, next);
          break;
        case 'released':
          pins.delete(hash);
          break;
      }
      return { ...state, pins };
    },
    handlers: {
      held: {
        blockReleased({ count }, _event, { emitState }) {
          emitState(count > 1 ? { kind: 'held', count: count - 1 } : { kind: 'released' });
        },
        blockRetired({ count }, _event, { emitState }) {
          emitState({ kind: 'retired', count });
        },
      },
      retired: {
        blockReleased({ count }, { hash }, { emitState, update }) {
          if (count > 1) {
            emitState({ kind: 'retired', count: count - 1 });
            return;
          }
          emitState({ kind: 'released' });
          unpin([hash], update);
        },
      },
      released: null,
    },
  });

  const machine = createStateMachine<FollowMachine>({
    initial: { kind: 'following', waiters: [] },
    handlers: {
      following: {
        waited(state, { waiter }, { emitState }) {
          emitState({ ...state, waiters: [...state.waiters, waiter] });
        },
        initialized(state, { newest, older }, { emitState, update }) {
          emitState({ kind: 'ready', bestHash: newest, newestFinalized: newest, pins: new Map() });
          unpin(older, update);
          for (const { resolve } of state.waiters) {
            resolve();
          }
        },
        followEnded: endFollow,
        destroyed: destroyFollow,
      },
      ready: {
        waited(_state, { waiter }) {
          waiter.resolve();
        },
        bestBlockChanged(state, { hash }, { emitState }) {
          emitState({ ...state, bestHash: hash });
        },
        // A server may stop a follow that lets pins pile up. Reads only target descendants of the newest finalized
        // block, so blocks finality leaves behind or prunes are unpinned, once the last read holding them ends.
        finalized(state, { finalized, pruned }, { emitState, update }) {
          const behind = finalized.length === 0 ? [] : [state.newestFinalized, ...finalized.slice(0, -1)];
          const free: string[] = [];
          const held: string[] = [];
          for (const hash of [...behind, ...pruned]) {
            (state.pins.has(hash) ? held : free).push(hash);
          }
          emitState({ ...state, newestFinalized: finalized.at(-1) ?? state.newestFinalized });
          for (const hash of held) {
            update({ kind: 'blockRetired', hash });
          }
          unpin(free, update);
        },
        blockHeld(state, { hash }, { emitState }) {
          const pin = state.pins.get(hash);
          const held: HeldPin = pin === undefined ? { kind: 'held', count: 1 } : { ...pin, count: pin.count + 1 };
          emitState({ ...state, pins: new Map(state.pins).set(hash, held) });
        },
        blockReleased: releasePin,
        blockRetired: releasePin,
        unpinFailed(_state, { error }, { emitSideEffect }) {
          // The follow stopped, and its pins went with it.
          if (error instanceof DisjointError) {
            return;
          }
          emitSideEffect({ kind: 'unpinRefused', error });
        },
        followEnded: endFollow,
        destroyed: destroyFollow,
      },
      // A disposed state handles nothing else, but a `whenReady` after the stop would otherwise never settle.
      stopped: {
        waited({ error }, { waiter }) {
          waiter.reject(error);
        },
      },
    },
    onEffect({ error }) {
      report.defect(error, {
        step: 'unpin',
        metric: resolveUnpinMetric,
        message: '[dot.li resolver] the light client refused an unpin:',
      });
    },
    onError(error) {
      report.defect(error, {
        step: 'raw_api_transition',
        metric: rawApiTransitionMetric,
        message: '[dot.li resolver] A chainHead follow transition threw',
      });
    },
  });

  const follow = client.chainHead(
    false,
    event => {
      switch (event.type) {
        case 'initialized': {
          const newest = event.finalizedBlockHashes.at(-1);
          if (newest === undefined) {
            machine.update({
              kind: 'followEnded',
              cause: new Error('chainHead follow initialized with no finalized block'),
            });
            // papi does not know the follow is dead, so it is ended here.
            follow.unfollow();
            return;
          }
          machine.update({ kind: 'initialized', newest, older: event.finalizedBlockHashes.slice(0, -1) });
          return;
        }
        case 'bestBlockChanged':
          machine.update({ kind: 'bestBlockChanged', hash: event.bestBlockHash });
          return;
        case 'finalized':
          machine.update({ kind: 'finalized', finalized: event.finalizedBlockHashes, pruned: event.prunedBlockHashes });
          return;
        case 'newBlock':
          // A new block changes no pin.
          return;
      }
    },
    error => {
      machine.update({ kind: 'followEnded', cause: error });
    },
  );

  function whenReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      machine.update({ kind: 'waited', waiter: { resolve, reject } });
    });
  }

  async function withStopGuard<T>(work: () => Promise<T>): Promise<T> {
    if (machine.state.get().kind === 'stopped') {
      throw new ApiStoppedError();
    }
    try {
      return await work();
    } catch (error) {
      if (error instanceof StopError) {
        machine.update({ kind: 'followEnded', cause: error });
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
    await whenReady();
    const state = machine.state.get();
    if (state.kind !== 'ready') {
      throw new ApiStoppedError();
    }
    const hash = state.bestHash;
    machine.update({ kind: 'blockHeld', hash });
    try {
      return await read(hash);
    } finally {
      machine.update({ kind: 'blockReleased', hash });
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
    whenReady,
    withBestBlock,
    resolveTrieId,
    async readSlot(contractAddress, slotKey, { atHash, trieId } = {}) {
      if (atHash === undefined) {
        return withBestBlock(hash => readSlotAt({ contractAddress, slotKey, hash, trieId }));
      }
      await whenReady();
      return readSlotAt({ contractAddress, slotKey, hash: atHash, trieId });
    },
    onStop(callback) {
      if (machine.state.get().kind === 'stopped') {
        stops.deliver(callback, undefined);
        return () => {
          /* already stopped */
        };
      }
      return stops.subscribe(callback);
    },
    destroy() {
      machine.update({ kind: 'destroyed' });
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
