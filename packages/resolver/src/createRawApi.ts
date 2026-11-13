// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Revive contract slots read straight from `chainHead_v1_storage`, with no runtime call or metadata. `trie_id` is
// never cached, because a redeploy would then return stale data.

import type { StorageItemResponse, SubstrateClient } from '@polkadot-api/substrate-client';
import { DisjointError } from '@polkadot-api/substrate-client';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  createStateMachine,
  fromHex,
  noop,
  toHex,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import { ApiStoppedError } from './apiStoppedError.js';
import { readWithRetry } from './readWithRetry.js';
import { decodeTrieId, getAccountInfoKey, getChildSlotKey } from './reviveStorageKeys.js';

const report = createReporter({ flow: 'resolve' });

/** Count. An unpin the light client refused while the follow ran, so pins pile up. Tag `outcome` and `reason`. */
const resolveUnpinMetric = defineCount<'error'>('resolve.unpin');

/**
 * Count. An unfollow that threw, a bug, since papi ends a follow that already stopped without a throw. The follow may
 * stay open on the server. Tag `outcome` and `reason`.
 */
const resolveUnfollowMetric = defineCount<'error'>('resolve.unfollow');

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
   * Reads a slot at `atHash`, a block a `withBestBlock` read holds, in the contract's `trieId`, resolved at that block
   * when not given. Resolves `null` when unset. Rejects with `ApiStoppedError` once the follow stopped, and otherwise
   * with the storage error, such as `OperationInaccessibleError` when no peer serves the read within its retry window.
   * A read the server refuses for its operation limit is retried within the same window, then rejects with
   * `OperationLimitError`.
   */
  readSlot(
    contractAddress: string,
    slotKey: `0x${string}`,
    at: { atHash: string; trieId?: Uint8Array | undefined },
  ): Promise<Uint8Array | null>;
  /**
   * Resolves each contract's `trie_id` at `atHash`, a block a `withBestBlock` read holds, keyed by the address as given.
   * `null` for an address that is not a contract. Rejects as `resolveTrieId` does.
   */
  resolveTrieIds(contractAddresses: readonly string[], atHash: string): Promise<ReadonlyMap<string, Uint8Array | null>>;
  /**
   * Reads many slots of one contract at `atHash`, in the contract's `trieId`, resolved at that block when not given.
   * Resolves the values in the order of `slotKeys`, `null` for an unset slot, and every value `null` when the account
   * is not a contract. Rejects as `readSlot` does.
   */
  readSlots(
    contractAddress: string,
    slotKeys: readonly `0x${string}`[],
    at: { atHash: string; trieId?: Uint8Array | undefined },
  ): Promise<(Uint8Array | null)[]>;
  /** Calls `callback` once the follow stops, at once if it already has. Fires at most once. Returns the unsubscribe. */
  onStop(callback: () => void): () => void;
  /**
   * Ends the follow as a stop, so `onStop` listeners fire and a pending `whenReady` rejects with `ApiStoppedError`.
   * Never throws. Leaves the owning `SubstrateClient` alive.
   */
  destroy(): void;
};

type Params = {
  client: SubstrateClient;
  /** The clock a read's retry window is measured on. */
  now?: () => number;
};

/** A block reads pin. A retired one is a block finality left behind while a read held it, unpinned once no read does. */
type Pin = { kind: 'held' | 'retired'; count: number };

/** A caller of `whenReady`, settled once the follow is ready or stopped. */
type Waiter = { resolve: () => void; reject: (error: ApiStoppedError) => void };

/**
 * Where the follow stands. A following one keeps who waits for it to be ready. A ready follow keeps the best block,
 * finality's newest block and the blocks reads hold.
 */
type FollowState =
  | { kind: 'following'; waiters: readonly Waiter[] }
  | { kind: 'ready'; bestHash: string; newestFinalized: string; pins: ReadonlyMap<string, Pin> }
  | { kind: 'stopped'; error: ApiStoppedError };

type FollowEvent =
  | { kind: 'waited'; waiter: Waiter }
  | { kind: 'initialized'; finalized: readonly string[] }
  | { kind: 'bestBlockChanged'; hash: string }
  | { kind: 'finalized'; finalized: readonly string[]; pruned: readonly string[] }
  | { kind: 'blockHeld'; hash: string }
  | { kind: 'blockReleased'; hash: string }
  // No state handles it: an unpin that went through changes nothing, but its work still has to end in an event.
  | { kind: 'unpinned' }
  | { kind: 'unpinFailed'; error: unknown }
  | { kind: 'followEnded'; cause: unknown }
  | { kind: 'destroyed' };

type FollowEffect =
  | { kind: 'wake'; waiters: readonly Waiter[] }
  | { kind: 'fail'; waiters: readonly Waiter[]; error: ApiStoppedError }
  | { kind: 'unpin'; hashes: readonly string[] }
  | { kind: 'unpinRefused'; error: unknown }
  | { kind: 'unfollow' }
  | { kind: 'stopped' };

type FollowMachine = MachineTypes<FollowState, FollowEvent, FollowEffect>;

// A server refuses operations past its per-follow limit, so each follow stays well under a common one.
const MAX_STORAGE_OPERATIONS = 8;

// A server discards the tail of a large storage call, so each call stays small enough to be served whole.
const MAX_BATCH_KEYS = 256;

/** Opens its own `chainHead` follow without runtime. The caller owns the client. */
export function createRawApi({ client, now = () => performance.now() }: Params): Api {
  const stops = createListenerSet<undefined>({ onListenerError: report.listener('resolver.stop') });
  const operations = createAsyncTaskPool({ poolSize: MAX_STORAGE_OPERATIONS });

  const endFollow: HandlerOf<FollowMachine, 'following' | 'ready', 'followEnded'> = (state, { cause }, transition) => {
    stop(state, new ApiStoppedError(cause), transition);
  };

  const destroyFollow: HandlerOf<FollowMachine, 'following' | 'ready', 'destroyed'> = (state, _event, transition) => {
    // `unfollow` stops the follow without calling its error callback, so the stop is told here.
    transition.emitSideEffect({ kind: 'unfollow' });
    stop(state, new ApiStoppedError(), transition);
  };

  const machine = createStateMachine<FollowMachine>({
    initial: { kind: 'following', waiters: [] },
    handlers: {
      following: {
        waited(state, { waiter }, { emitState }) {
          emitState({ ...state, waiters: [...state.waiters, waiter] });
        },
        initialized(state, { finalized }, transition) {
          const newest = finalized.at(-1);
          // papi does not know a follow with no finalized block is dead, so it is ended here.
          if (newest === undefined) {
            const cause = new Error('chainHead follow initialized with no finalized block');
            transition.emitSideEffect({ kind: 'unfollow' });
            stop(state, new ApiStoppedError(cause), transition);
            return;
          }
          transition.emitState({ kind: 'ready', bestHash: newest, newestFinalized: newest, pins: new Map() });
          transition.emitSideEffect({ kind: 'unpin', hashes: finalized.slice(0, -1) });
          transition.emitSideEffect({ kind: 'wake', waiters: state.waiters });
        },
        followEnded: endFollow,
        destroyed: destroyFollow,
      },
      ready: {
        waited(_state, { waiter }, { emitSideEffect }) {
          emitSideEffect({ kind: 'wake', waiters: [waiter] });
        },
        bestBlockChanged(state, { hash }, { emitState }) {
          emitState({ ...state, bestHash: hash });
        },
        // A server may stop a follow that lets pins pile up. Reads only target descendants of the newest finalized
        // block, so blocks finality leaves behind or prunes are unpinned, once the last read holding them ends.
        finalized(state, { finalized, pruned }, { emitState, emitSideEffect }) {
          const behind = finalized.length === 0 ? [] : [state.newestFinalized, ...finalized.slice(0, -1)];
          const left = [...behind, ...pruned];
          const pins = new Map(state.pins);
          for (const hash of left) {
            const pin = pins.get(hash);
            if (pin !== undefined) {
              pins.set(hash, { kind: 'retired', count: pin.count });
            }
          }
          emitState({ ...state, newestFinalized: finalized.at(-1) ?? state.newestFinalized, pins });
          emitSideEffect({ kind: 'unpin', hashes: left.filter(hash => !state.pins.has(hash)) });
        },
        blockHeld(state, { hash }, { emitState }) {
          const pin = state.pins.get(hash) ?? { kind: 'held', count: 0 };
          emitState({ ...state, pins: new Map(state.pins).set(hash, { ...pin, count: pin.count + 1 }) });
        },
        blockReleased(state, { hash }, { emitState, emitSideEffect }) {
          const pin = state.pins.get(hash);
          if (pin === undefined) {
            return;
          }
          const pins = new Map(state.pins);
          if (pin.count > 1) {
            emitState({ ...state, pins: pins.set(hash, { ...pin, count: pin.count - 1 }) });
            return;
          }
          pins.delete(hash);
          emitState({ ...state, pins });
          if (pin.kind === 'retired') {
            emitSideEffect({ kind: 'unpin', hashes: [hash] });
          }
        },
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
      // A stopped follow handles nothing else, but a `whenReady` after the stop would otherwise never settle.
      stopped: {
        waited({ error }, { waiter }, { emitSideEffect }) {
          emitSideEffect({ kind: 'fail', waiters: [waiter], error });
        },
      },
    },
    onEffect: runEffect,
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
        case 'initialized':
          machine.update({ kind: 'initialized', finalized: event.finalizedBlockHashes });
          return;
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

  /** Moves a running follow to `stopped`, fails who waits for it to be ready, and tells the stop listeners. */
  function stop(
    state: Exclude<FollowState, { kind: 'stopped' }>,
    error: ApiStoppedError,
    { emitState, emitSideEffect }: Transition<FollowMachine>,
  ): void {
    emitState({ kind: 'stopped', error });
    emitSideEffect({ kind: 'fail', waiters: state.kind === 'following' ? state.waiters : [], error });
    emitSideEffect({ kind: 'stopped' });
  }

  function runEffect(effect: FollowEffect): void {
    switch (effect.kind) {
      case 'wake':
        for (const { resolve } of effect.waiters) {
          resolve();
        }
        return;
      case 'fail':
        for (const { reject } of effect.waiters) {
          reject(effect.error);
        }
        return;
      case 'unpin':
        if (effect.hashes.length === 0) {
          return;
        }
        machine.update(
          follow.unpin([...effect.hashes]).then(
            () => ({ kind: 'unpinned' }),
            (error: unknown) => ({ kind: 'unpinFailed', error }),
          ),
        );
        return;
      case 'unpinRefused':
        report.defect(effect.error, {
          step: 'unpin',
          metric: resolveUnpinMetric,
          message: '[dot.li resolver] the light client refused an unpin:',
        });
        return;
      case 'unfollow':
        try {
          follow.unfollow();
        } catch (error: unknown) {
          report.defect(error, {
            step: 'unfollow',
            metric: resolveUnfollowMetric,
            message: '[dot.li resolver] A chainHead unfollow threw:',
          });
        }
        return;
      case 'stopped':
        stops.emit(undefined);
        return;
    }
  }

  function whenReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      machine.update({ kind: 'waited', waiter: { resolve, reject } });
    });
  }

  // Each attempt queues on its own, so a retry wait holds no operation slot. A papi read in flight when the follow
  // stops rejects with its own `DisjointError`.
  function runOperation<T>(start: () => Promise<T>): Promise<T> {
    return readWithRetry(
      () =>
        operations.call(() => {
          if (machine.state.get().kind === 'stopped') {
            throw new ApiStoppedError();
          }
          return start();
        }),
      now,
    );
  }

  function readStorage(hash: string, key: string, childTrie: string | null): Promise<string | null> {
    return runOperation(() => follow.storage(hash, 'value', key, childTrie));
  }

  // Resolves the values by key. A key the server did not return is absent, which reads as unset. Each call retries and
  // queues for an operation slot on its own, and the tail a server discarded from a call goes out again once it ends.
  async function readStorageBatch(
    hash: string,
    keys: readonly string[],
    childTrie: string | null,
  ): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    const calls: (readonly string[])[] = [];
    for (let start = 0; start < keys.length; start += MAX_BATCH_KEYS) {
      calls.push(keys.slice(start, start + MAX_BATCH_KEYS));
    }
    await Promise.all(
      calls.map(async callKeys => {
        let pending = callKeys;
        while (pending.length > 0) {
          const asked = pending;
          const { items, discarded } = await runOperation(() => subscribeStorage(hash, asked, childTrie));
          for (const { key, value } of items) {
            if (value !== undefined) {
              values.set(key, value);
            }
          }
          pending = asked.slice(asked.length - discarded);
        }
      }),
    );
    return values;
  }

  // papi reports the discarded count once, before any items, and may split the items over several events. Each
  // attempt keeps its own items, so a retried attempt drops what a failed one received.
  function subscribeStorage(
    hash: string,
    keys: readonly string[],
    childTrie: string | null,
  ): Promise<{ items: StorageItemResponse[]; discarded: number }> {
    return new Promise((resolve, reject) => {
      const items: StorageItemResponse[] = [];
      let discarded = 0;
      follow.storageSubscription(
        hash,
        keys.map(key => ({ key, type: 'value' })),
        childTrie,
        received => {
          items.push(...received);
        },
        reject,
        () => {
          resolve({ items, discarded });
        },
        count => {
          discarded = count;
        },
      );
    });
  }

  async function resolveTrieId(contractAddress: string, atHash: string): Promise<Uint8Array | null> {
    const accountInfoHex = await readStorage(atHash, getAccountInfoKey(contractAddress), null);
    return accountInfoHex === null ? null : decodeTrieId(accountInfoHex);
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

  return {
    whenReady,
    withBestBlock,
    resolveTrieId,
    async readSlot(contractAddress, slotKey, { atHash, trieId }) {
      const trie = trieId ?? (await resolveTrieId(contractAddress, atHash));
      if (trie === null) {
        return null;
      }
      const valueHex = await readStorage(atHash, getChildSlotKey(slotKey), toHex(trie));
      return valueHex === null ? null : fromHex(valueHex);
    },
    async resolveTrieIds(contractAddresses, atHash) {
      const accounts = contractAddresses.map(address => ({ address, key: getAccountInfoKey(address) }));
      const accountInfos = await readStorageBatch(
        atHash,
        accounts.map(({ key }) => key),
        null,
      );
      const trieIds = new Map<string, Uint8Array | null>();
      for (const { address, key } of accounts) {
        const accountInfoHex = accountInfos.get(key);
        trieIds.set(address, accountInfoHex === undefined ? null : decodeTrieId(accountInfoHex));
      }
      return trieIds;
    },
    async readSlots(contractAddress, slotKeys, { atHash, trieId }) {
      const trie = trieId ?? (await resolveTrieId(contractAddress, atHash));
      if (trie === null) {
        return slotKeys.map(() => null);
      }
      const childKeys = slotKeys.map(slotKey => getChildSlotKey(slotKey));
      const values = await readStorageBatch(atHash, childKeys, toHex(trie));
      return childKeys.map(childKey => {
        const valueHex = values.get(childKey);
        return valueHex === undefined ? null : fromHex(valueHex);
      });
    },
    onStop(callback) {
      if (machine.state.get().kind === 'stopped') {
        stops.deliver(callback, undefined);
        return noop;
      }
      return stops.subscribe(callback);
    },
    destroy() {
      machine.update({ kind: 'destroyed' });
    },
  };
}
