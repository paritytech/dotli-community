// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Revive contract slots read straight from `chainHead_v1_storage`, with no runtime call or metadata. `trie_id` is
// never cached, because a redeploy would then return stale data.

import type { SubstrateClient } from '@polkadot-api/substrate-client';
import { DisjointError } from '@polkadot-api/substrate-client';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  createStateMachine,
  fromHex,
  noop,
  toHex,
  waitForStatus,
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

/** A block reads pin. A retired one is a block finality left behind while a read held it, unpinned once no read does. */
type Pin = { kind: 'held' | 'retired'; count: number };

/** Where the follow stands. A ready follow keeps the best block, finality's newest block and the blocks reads hold. */
type FollowState =
  | { kind: 'following' }
  | { kind: 'ready'; bestHash: string; newestFinalized: string; pins: ReadonlyMap<string, Pin> }
  | { kind: 'stopped'; error: ApiStoppedError };

type FollowEvent =
  | { kind: 'initialized'; finalized: readonly string[] }
  | { kind: 'bestBlockChanged'; hash: string }
  | { kind: 'finalized'; finalized: readonly string[]; pruned: readonly string[] }
  | { kind: 'blockHeld'; hash: string }
  | { kind: 'blockReleased'; hash: string }
  | { kind: 'unpinned' }
  | { kind: 'unpinFailed'; error: unknown }
  | { kind: 'followEnded'; cause: unknown }
  | { kind: 'destroyed' };

type FollowEffect =
  | { kind: 'unpin'; hashes: readonly string[] }
  | { kind: 'unpinRefused'; error: unknown }
  | { kind: 'unfollow' }
  | { kind: 'stopped' };

type FollowMachine = MachineTypes<FollowState, FollowEvent, FollowEffect>;

// A server refuses operations past its per-follow limit, so each follow stays well under a common one.
const MAX_STORAGE_OPERATIONS = 8;

/** Opens its own `chainHead` follow without runtime. The caller owns the client. */
export function createRawApi({ client, now = () => performance.now() }: Params): Api {
  const stops = createListenerSet<undefined>({ onListenerError: report.listener('resolver.stop') });
  const operations = createAsyncTaskPool({ poolSize: MAX_STORAGE_OPERATIONS });

  const endFollow: HandlerOf<FollowMachine, 'following' | 'ready', 'followEnded'> = (
    _state,
    { cause },
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'stopped', error: new ApiStoppedError(cause) });
    emitSideEffect({ kind: 'stopped' });
  };

  const destroyFollow: HandlerOf<FollowMachine, 'following' | 'ready', 'destroyed'> = (_state, _event, transition) => {
    unfollow(new ApiStoppedError(), transition);
  };

  const machine = createStateMachine<FollowMachine>({
    initial: { kind: 'following' },
    handlers: {
      following: {
        initialized(_state, { finalized }, transition) {
          const newest = finalized.at(-1);
          // papi does not know a follow with no finalized block is dead, so it is ended here.
          if (newest === undefined) {
            const cause = new Error('chainHead follow initialized with no finalized block');
            unfollow(new ApiStoppedError(cause), transition);
            return;
          }
          transition.emitState({ kind: 'ready', bestHash: newest, newestFinalized: newest, pins: new Map() });
          transition.emitSideEffect({ kind: 'unpin', hashes: finalized.slice(0, -1) });
        },
        followEnded: endFollow,
        destroyed: destroyFollow,
      },
      ready: {
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
      stopped: null,
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

  /** Ends the follow itself. `unfollow` stops it without calling its error callback, so the stop is told here. */
  function unfollow(error: ApiStoppedError, { emitState, emitSideEffect }: Transition<FollowMachine>): void {
    emitState({ kind: 'stopped', error });
    emitSideEffect({ kind: 'unfollow' });
    emitSideEffect({ kind: 'stopped' });
  }

  function runEffect(effect: FollowEffect): void {
    switch (effect.kind) {
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
          // eslint-disable-next-line no-restricted-syntax -- best-effort teardown: the follow may already be stopped.
        } catch {
          /* already stopped */
        }
        return;
      case 'stopped':
        stops.emit(undefined);
        return;
    }
  }

  async function whenReady(): Promise<void> {
    await waitForStatus(machine.state, getReadiness);
  }

  // Each attempt queues on its own, so a retry wait holds no operation slot. A papi read in flight when the follow
  // stops rejects with its own `DisjointError`.
  function readStorage({ hash, key, childTrie }: ReadStorageParams): Promise<string | null> {
    return readWithRetry(
      () =>
        operations.call(() => {
          if (machine.state.get().kind === 'stopped') {
            throw new ApiStoppedError();
          }
          return follow.storage(hash, 'value', key, childTrie);
        }),
      now,
    );
  }

  async function resolveTrieId(contractAddress: string, atHash: string): Promise<Uint8Array | null> {
    const accountInfoHex = await readStorage({
      hash: atHash,
      key: getAccountInfoKey(contractAddress),
      childTrie: null,
    });
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
    const valueHex = await readStorage({ hash, key: getChildSlotKey(slotKey), childTrie: toHex(trie) });
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
        return noop;
      }
      return stops.subscribe(callback);
    },
    destroy() {
      machine.update({ kind: 'destroyed' });
    },
  };
}

/** A ready follow settles a wait for it, and a stopped one fails it with its stop. */
function getReadiness(state: FollowState): boolean | ApiStoppedError {
  switch (state.kind) {
    case 'following':
      return false;
    case 'ready':
      return true;
    case 'stopped':
      return state.error;
  }
}
