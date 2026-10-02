// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The seam: papi's `SubstrateClient.chainHead`. The fake hands the test the
// follow's event callback and records what the API sends back on the follow.

import { describe, expect, it, vi, type Mock } from 'vitest';
import type { FollowEventWithoutRuntime, SubstrateClient } from '@polkadot-api/substrate-client';
import { readMappingAddress, readMappingBytes } from '../src/access-raw-storage.js';
import { createRawApi } from '../src/api.js';

type StorageFn = (hash: string, type: string, key: string, childTrie: string | null) => Promise<string | null>;

interface FakeFollow {
  emit: (event: FollowEventWithoutRuntime) => void;
  storage: Mock<StorageFn>;
  unpin: Mock<(hashes: string[]) => Promise<void>>;
}

function fakeClient(): { client: SubstrateClient; follow: FakeFollow } {
  const follow: FakeFollow = {
    emit: () => undefined,
    storage: vi.fn<StorageFn>(() => Promise.resolve(null)),
    unpin: vi.fn<(hashes: string[]) => Promise<void>>(() => Promise.resolve()),
  };
  const client = {
    chainHead: (_withRuntime: boolean, onEvent: (event: FollowEventWithoutRuntime) => void) => {
      follow.emit = onEvent;
      return {
        storage: follow.storage,
        unpin: follow.unpin,
        unfollow: () => undefined,
      };
    },
  } as unknown as SubstrateClient;
  return { client, follow };
}

/** `Revive::AccountInfoOf` for a contract whose child trie id is `0x01`. */
const CONTRACT_ACCOUNT_INFO = '0x000401';

function newBlock(blockHash: string, parentBlockHash: string): FollowEventWithoutRuntime {
  return { type: 'newBlock', blockHash, parentBlockHash };
}

describe('createRawApi', () => {
  it('As a dotli user on a light client, the resolver unpins blocks once finality leaves them behind', () => {
    // Given
    const { client, follow } = fakeClient();
    createRawApi(client);
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x00', '0x0a'] });
    follow.emit(newBlock('0x1a', '0x0a'));
    follow.emit(newBlock('0x1b', '0x0a'));
    follow.emit(newBlock('0x2a', '0x1a'));
    follow.emit({ type: 'bestBlockChanged', bestBlockHash: '0x2a' });

    // When
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x1a'], prunedBlockHashes: ['0x1b'] });
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x2a'], prunedBlockHashes: [] });

    // Then
    expect(follow.unpin.mock.calls).toEqual([[['0x00']], [['0x0a', '0x1b']], [['0x1a']]]);
  });

  it('As a dotli user on a light client, a block a read is still using stays pinned until the read finishes', async () => {
    // Given
    const { client, follow } = fakeClient();
    const api = createRawApi(client);
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    let finishRead = (): void => undefined;
    const read = api.withBestBlock(
      () =>
        new Promise<void>(resolve => {
          finishRead = resolve;
        }),
    );
    await Promise.resolve();

    // When
    follow.emit(newBlock('0x1a', '0x0a'));
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x1a'], prunedBlockHashes: [] });
    const unpinnedDuringRead = [...follow.unpin.mock.calls];
    finishRead();
    await read;

    // Then
    expect(unpinnedDuringRead).toEqual([]);
    expect(follow.unpin.mock.calls).toEqual([[['0x0a']]]);
  });

  it("As a dotli user on a light client, a name's multi-slot read keeps its block pinned while finality moves on", async () => {
    // Given
    const { client, follow } = fakeClient();
    const api = createRawApi(client);
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    let answerSlot = (): void => undefined;
    follow.storage
      .mockImplementationOnce(() => Promise.resolve(CONTRACT_ACCOUNT_INFO))
      .mockImplementationOnce(
        () =>
          new Promise<string | null>(resolve => {
            answerSlot = () => {
              resolve(null);
            };
          }),
      );
    const read = readMappingBytes(api, '0x0000000000000000000000000000000000000001', `0x${'00'.repeat(32)}`, 0);
    await vi.waitFor(() => {
      expect(follow.storage).toHaveBeenCalledTimes(2);
    });

    // When
    follow.emit(newBlock('0x1a', '0x0a'));
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x1a'], prunedBlockHashes: [] });
    const unpinnedDuringRead = [...follow.unpin.mock.calls];
    answerSlot();
    await read;

    // Then
    expect(unpinnedDuringRead).toEqual([]);
    expect(follow.storage.mock.calls.map(([hash]) => hash)).toEqual(['0x0a', '0x0a']);
    expect(follow.unpin.mock.calls).toEqual([[['0x0a']]]);
  });

  it("As a dotli user on a light client, a name's owner lookup keeps its block pinned while finality moves on", async () => {
    // Given
    const { client, follow } = fakeClient();
    const api = createRawApi(client);
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    let answerSlot = (): void => undefined;
    follow.storage
      .mockImplementationOnce(() => Promise.resolve(CONTRACT_ACCOUNT_INFO))
      .mockImplementationOnce(
        () =>
          new Promise<string | null>(resolve => {
            answerSlot = () => {
              resolve(null);
            };
          }),
      );
    const read = readMappingAddress(api, '0x0000000000000000000000000000000000000001', `0x${'00'.repeat(32)}`, 0);
    await vi.waitFor(() => {
      expect(follow.storage).toHaveBeenCalledTimes(2);
    });

    // When
    follow.emit(newBlock('0x1a', '0x0a'));
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x1a'], prunedBlockHashes: [] });
    const unpinnedDuringRead = [...follow.unpin.mock.calls];
    answerSlot();
    await read;

    // Then
    expect(unpinnedDuringRead).toEqual([]);
    expect(follow.unpin.mock.calls).toEqual([[['0x0a']]]);
  });
});
