// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Faked at papi's `SubstrateClient.chainHead`, which hands the test the follow's event callback.

import { vi, type Mock } from 'vitest';
import { StopError, type FollowEventWithoutRuntime, type SubstrateClient } from '@polkadot-api/substrate-client';

type StorageFn = (hash: string, type: string, key: string, childTrie: string | null) => Promise<string | null>;

/** The test's side of one chainHead follow. */
export type FakeFollow = {
  /** Delivers a follow event, once the client under test opened the follow. */
  emit: (event: FollowEventWithoutRuntime) => void;
  /** Stops the follow with papi's `StopError`. */
  stop: () => void;
  /** Answers every storage request. Resolves `null` unless the test sets an answer. */
  storage: Mock<StorageFn>;
  /** Answers every unpin. Resolves unless the test sets an answer. */
  unpin: Mock<(hashes: string[]) => Promise<void>>;
};

/** A `SubstrateClient` whose one chainHead follow the test drives. */
export function createFakeSubstrateClient(): { client: SubstrateClient; follow: FakeFollow } {
  const follow: FakeFollow = {
    emit: () => undefined,
    stop: () => undefined,
    storage: vi.fn<StorageFn>(() => Promise.resolve(null)),
    unpin: vi.fn<(hashes: string[]) => Promise<void>>(() => Promise.resolve()),
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
        unpin: follow.unpin,
        unfollow: () => undefined,
      };
    },
  } as unknown as SubstrateClient;
  return { client, follow };
}
