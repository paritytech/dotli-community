// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Faked at papi's `SubstrateClient.chainHead`, which hands the test the follow's event callback.

import { vi, type Mock } from 'vitest';
import {
  StopError,
  type FollowEventWithoutRuntime,
  type FollowResponse,
  type SubstrateClient,
} from '@polkadot-api/substrate-client';

type StorageFn = (hash: string, type: string, key: string, childTrie: string | null) => Promise<string | null>;
type StorageSubscriptionFn = FollowResponse['storageSubscription'];

/** The test's side of one chainHead follow. */
export type FakeFollow = {
  /** Delivers a follow event, once the client under test opened the follow. */
  emit: (event: FollowEventWithoutRuntime) => void;
  /** Stops the follow with papi's `StopError`. */
  stop: () => void;
  /** Answers every storage request. Resolves `null` unless the test sets an answer. */
  storage: Mock<StorageFn>;
  /**
   * Answers every batched storage request. Unless the test replaces it, reports no discarded key, answers each key
   * through `storage`, delivers the set ones in one items event and ends, or reports the first `storage` rejection.
   */
  storageSubscription: Mock<StorageSubscriptionFn>;
  /** Answers every unpin. Resolves unless the test sets an answer. */
  unpin: Mock<(hashes: string[]) => Promise<void>>;
  /** Ends the follow. Returns unless the test makes it throw. */
  unfollow: Mock<() => void>;
};

/** A `SubstrateClient` whose one chainHead follow the test drives. */
export function createFakeSubstrateClient(): { client: SubstrateClient; follow: FakeFollow } {
  const follow: FakeFollow = {
    emit: () => undefined,
    stop: () => undefined,
    storage: vi.fn<StorageFn>(() => Promise.resolve(null)),
    storageSubscription: vi.fn<StorageSubscriptionFn>(
      (hash, inputs, childTrie, onItems, onError, onDone, onDiscardedItems) => {
        onDiscardedItems(0);
        void Promise.all(
          inputs.map(async ({ key }) => ({ key, value: await follow.storage(hash, 'value', key, childTrie) })),
        ).then(
          answers => {
            onItems(answers.flatMap(({ key, value }) => (value === null ? [] : [{ key, value }])));
            onDone();
          },
          (error: unknown) => {
            onError(error instanceof Error ? error : new Error('fake storage rejected', { cause: error }));
          },
        );
        return () => undefined;
      },
    ),
    unpin: vi.fn<(hashes: string[]) => Promise<void>>(() => Promise.resolve()),
    unfollow: vi.fn<() => void>(),
  };
  // The resolver calls only `chainHead`, so the rest of the client stays out of the fake.
  const client = {
    chainHead: (
      _withRuntime: boolean,
      onEvent: (event: FollowEventWithoutRuntime) => void,
      onError: (error: Error) => void,
    ) => {
      follow.emit = onEvent;
      follow.stop = () => {
        onError(new StopError());
      };
      return {
        storage: follow.storage,
        storageSubscription: follow.storageSubscription,
        unpin: follow.unpin,
        unfollow: follow.unfollow,
      };
    },
  } as unknown as SubstrateClient;
  return { client, follow };
}
