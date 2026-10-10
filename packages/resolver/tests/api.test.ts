// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Faked at papi's `SubstrateClient.chainHead`, which hands the test the follow's event callback.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  OperationInaccessibleError,
  StopError,
  type FollowEventWithoutRuntime,
  type SubstrateClient,
} from '@polkadot-api/substrate-client';
import { readMappingAddress, readMappingBytes } from '../src/access-raw-storage.js';
import { ApiStoppedError, createRawApi } from '../src/api.js';

type StorageFn = (hash: string, type: string, key: string, childTrie: string | null) => Promise<string | null>;

interface FakeFollow {
  emit: (event: FollowEventWithoutRuntime) => void;
  stop: () => void;
  storage: Mock<StorageFn>;
  unpin: Mock<(hashes: string[]) => Promise<void>>;
}

function fakeClient(): { client: SubstrateClient; follow: FakeFollow } {
  const follow: FakeFollow = {
    emit: () => undefined,
    stop: () => undefined,
    storage: vi.fn<StorageFn>(() => Promise.resolve(null)),
    unpin: vi.fn<(hashes: string[]) => Promise<void>>(() => Promise.resolve()),
  };
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

  describe('a storage read the light client cannot serve yet', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('As a dotli user on a freshly synced light client, a name read the node cannot serve yet is retried until it answers', async () => {
      // Given
      const { client, follow } = fakeClient();
      const api = createRawApi(client);
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      follow.storage
        .mockImplementationOnce(() => Promise.reject(new OperationInaccessibleError()))
        .mockImplementationOnce(() => Promise.resolve(CONTRACT_ACCOUNT_INFO))
        .mockImplementationOnce(() => Promise.reject(new OperationInaccessibleError()))
        .mockImplementationOnce(() => Promise.resolve(CONTRACT_ACCOUNT_INFO))
        .mockImplementationOnce(() => Promise.resolve(`0x01${'00'.repeat(30)}02`));

      // When
      const read = readMappingBytes(api, '0x0000000000000000000000000000000000000001', `0x${'00'.repeat(32)}`, 0);
      const settled = expect(read).resolves.toEqual(new Uint8Array([0x01]));
      await vi.runAllTimersAsync();

      // Then
      await settled;
      expect(follow.storage).toHaveBeenCalledTimes(5);
    });

    it('restarts an inaccessible multi-slot read at the current head without mixing blocks or child tries', async () => {
      const { client, follow } = fakeClient();
      const api = createRawApi(client);
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      let oldSlots = 0;
      let newSlots = 0;
      follow.storage.mockImplementation((hash, _type, _key, childTrie) => {
        if (childTrie === null) {
          return Promise.resolve(hash === '0x0a' ? CONTRACT_ACCOUNT_INFO : '0x000402');
        }
        if (hash === '0x0a') {
          oldSlots += 1;
          if (oldSlots === 1) {
            return Promise.resolve(`0x${'00'.repeat(31)}43`);
          }
          if (oldSlots === 2) {
            return Promise.resolve(`0x${'aa'.repeat(32)}`);
          }
          if (oldSlots === 3) {
            follow.emit(newBlock('0x1a', '0x0a'));
            follow.emit({ type: 'bestBlockChanged', bestBlockHash: '0x1a' });
            follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x1a'], prunedBlockHashes: [] });
          }
          return Promise.reject(new OperationInaccessibleError());
        }
        newSlots += 1;
        return Promise.resolve(
          newSlots === 1 ? `0x${'00'.repeat(31)}43` : `0x${(newSlots === 2 ? 'bb' : 'cc').repeat(32)}`,
        );
      });

      const read = readMappingBytes(api, '0x0000000000000000000000000000000000000001', `0x${'00'.repeat(32)}`, 0);
      const settled = read.then(
        value => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      await vi.runAllTimersAsync();
      expect(await settled).toEqual({
        value: new Uint8Array([...new Array<number>(32).fill(0xbb), 0xcc]),
        error: null,
      });
      expect(follow.storage.mock.calls.filter(([hash]) => hash === '0x1a').map(([, , , trie]) => trie)).toEqual([
        null,
        '0x02',
        '0x02',
        '0x02',
      ]);
      expect(follow.unpin.mock.calls).toEqual([[['0x0a']]]);
    });

    it('As a dotli user on a light client that never serves a read, the read fails instead of retrying forever', async () => {
      // Given
      const { client, follow } = fakeClient();
      const api = createRawApi(client);
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      follow.storage.mockImplementation(() => Promise.reject(new OperationInaccessibleError()));

      // When
      const read = api.withBestBlock(hash => api.resolveTrieId('0x0000000000000000000000000000000000000001', hash));
      const settled = expect(read).rejects.toBeInstanceOf(OperationInaccessibleError);
      await vi.runAllTimersAsync();

      // Then
      await settled;
    });

    it('As a dotli user on a light client, a read waiting to retry stops when the chain follow stops', async () => {
      // Given
      const { client, follow } = fakeClient();
      const api = createRawApi(client);
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      follow.storage.mockImplementation(() => Promise.reject(new OperationInaccessibleError()));
      const read = api.withBestBlock(hash => api.resolveTrieId('0x0000000000000000000000000000000000000001', hash));
      const settled = expect(read).rejects.toBeInstanceOf(ApiStoppedError);
      await vi.advanceTimersByTimeAsync(0);

      // When
      follow.stop();
      await vi.runAllTimersAsync();

      // Then
      await settled;
      expect(follow.storage).toHaveBeenCalledTimes(1);
    });
  });
});
