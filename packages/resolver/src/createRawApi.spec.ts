// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DisjointError, OperationInaccessibleError, OperationLimitError } from '@polkadot-api/substrate-client';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { catchError } from '@dotli/shared/testing';
import { ApiStoppedError } from './apiStoppedError.js';
import { createRawApi, type Api } from './createRawApi.js';
import { CONTRACT_ADDRESS } from './testing/constants.js';
import { createFakeSubstrateClient } from './testing/createFakeSubstrateClient.js';
import { createNewBlockEvent } from './testing/createNewBlockEvent.js';

describe('createRawApi', () => {
  it('As a dotli user on a light client, I let finality move on and the resolver unpins the blocks it left behind', () => {
    // Given
    const { client, follow } = createFakeSubstrateClient();
    createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x00', '0x0a'] });
    follow.emit(createNewBlockEvent('0x1a', '0x0a'));
    follow.emit(createNewBlockEvent('0x1b', '0x0a'));
    follow.emit(createNewBlockEvent('0x2a', '0x1a'));
    follow.emit({ type: 'bestBlockChanged', bestBlockHash: '0x2a' });

    // When
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x1a'], prunedBlockHashes: ['0x1b'] });
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x2a'], prunedBlockHashes: [] });

    // Then
    expect(follow.unpin.mock.calls).toEqual([[['0x00']], [['0x0a', '0x1b']], [['0x1a']]]);
  });

  it('As a dotli user on a light client, I read at a block while finality moves on and the block stays pinned until the read finishes', async () => {
    // Given
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    const holdTaken = createDeferred<undefined>();
    const readFinished = createDeferred<undefined>();
    const read = api.withBestBlock(() => {
      holdTaken.resolve(undefined);
      return readFinished.promise;
    });
    await holdTaken.promise;

    // When
    follow.emit(createNewBlockEvent('0x1a', '0x0a'));
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x1a'], prunedBlockHashes: [] });
    const unpinnedDuringRead = [...follow.unpin.mock.calls];
    readFinished.resolve(undefined);
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

    it('As the resolver, I read a slot no peer serves, and the read fails after about 30 s even when each attempt is slow', async () => {
      // Given
      const { client, follow } = createFakeSubstrateClient();
      let clock = 0;
      const api = createRawApi({
        client,
        now: () => {
          const reading = clock;
          clock += 10_000;
          return reading;
        },
      });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      follow.storage.mockImplementation(() => Promise.reject(new OperationInaccessibleError()));

      // When
      const read = api.resolveTrieId(CONTRACT_ADDRESS, '0x0a').catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await read;

      // Then
      expect(error).toBeInstanceOf(OperationInaccessibleError);
      expect(follow.storage.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('As a dotli user on a light client, I wait on a read retry and the read stops when the chain follow stops', async () => {
      // Given
      const { client, follow } = createFakeSubstrateClient();
      const api = createRawApi({ client });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      const storageAsked = createDeferred<undefined>();
      follow.storage.mockImplementation(() => {
        storageAsked.resolve(undefined);
        return Promise.reject(new OperationInaccessibleError());
      });
      const read = api.resolveTrieId(CONTRACT_ADDRESS, '0x0a').catch((error: unknown) => error);
      await storageAsked.promise;

      // When
      follow.stop();
      await vi.runAllTimersAsync();
      const error = await read;

      // Then
      expect(error).toBeInstanceOf(ApiStoppedError);
      expect(follow.storage).toHaveBeenCalledTimes(1);
    });
  });

  describe("the follow's storage operations", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('As the resolver, I start nine slot reads at once and the follow runs eight of them until one ends', async () => {
      // Given
      const { client, follow } = createFakeSubstrateClient();
      const api = createRawApi({ client });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      const answers: ReturnType<typeof createDeferred<string | null>>[] = [];
      follow.storage.mockImplementation(() => {
        const answer = createDeferred<string | null>();
        answers.push(answer);
        return answer.promise;
      });

      // When nine reads start and the first one ends
      for (let index = 0; index < 9; index += 1) {
        void readSlotAt(api, index);
      }
      await vi.advanceTimersByTimeAsync(0);
      const before = follow.storage.mock.calls.length;
      answers[0]?.resolve(null);
      await vi.advanceTimersByTimeAsync(0);

      // Then
      expect(before).toBe(8);
      expect(follow.storage.mock.calls.length).toBe(9);
    });

    it('As the resolver, I wait on eight read retries and a ninth read still runs', async () => {
      // Given
      const { client, follow } = createFakeSubstrateClient();
      const api = createRawApi({ client });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      let calls = 0;
      follow.storage.mockImplementation(() => {
        calls += 1;
        return calls <= 8 ? Promise.reject(new OperationInaccessibleError()) : Promise.resolve(null);
      });
      for (let index = 0; index < 8; index += 1) {
        readSlotAt(api, index).catch(() => undefined);
      }
      await vi.advanceTimersByTimeAsync(0);

      // When a ninth read starts while the eight wait to retry
      let ninthSettled = false;
      void readSlotAt(api, 8).then(() => {
        ninthSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      // Then
      expect(ninthSettled).toBe(true);
      expect(follow.storage).toHaveBeenCalledTimes(9);
    });

    it('As the resolver, I queue a read behind eight running ones and it stops without asking the follow once the follow stops', async () => {
      // Given
      const { client, follow } = createFakeSubstrateClient();
      const api = createRawApi({ client });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      const answers: ReturnType<typeof createDeferred<string | null>>[] = [];
      for (let index = 0; index < 8; index += 1) {
        const answer = createDeferred<string | null>();
        answers.push(answer);
        follow.storage.mockImplementationOnce(() => answer.promise);
      }
      for (let index = 0; index < 8; index += 1) {
        void readSlotAt(api, index);
      }
      const ninth = readSlotAt(api, 8).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);

      // When the follow stops and a running read ends
      follow.stop();
      answers[0]?.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      const error = await ninth;

      // Then
      expect(error).toBeInstanceOf(ApiStoppedError);
      expect(follow.storage).toHaveBeenCalledTimes(8);
    });

    it('As a dotli user on a busy follow, I read a slot the server refuses for its operation limit and the read is retried until it answers', async () => {
      // Given
      const { client, follow } = createFakeSubstrateClient();
      const api = createRawApi({ client });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      follow.storage
        .mockImplementationOnce(() => Promise.reject(new OperationLimitError()))
        .mockImplementationOnce(() => Promise.resolve(`0x${'00'.repeat(31)}01`));

      // When
      const read = readSlotAt(api, 0);
      await vi.runAllTimersAsync();
      const value = await read;

      // Then
      expect(value).toBeInstanceOf(Uint8Array);
      expect(value?.length).toBe(32);
      expect(value?.at(-1)).toBe(1);
      expect(follow.storage).toHaveBeenCalledTimes(2);
    });

    it('As a dotli user on a follow that keeps refusing, I read a slot and the read fails with the operation limit error instead of retrying forever', async () => {
      // Given
      const { client, follow } = createFakeSubstrateClient();
      const api = createRawApi({ client });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      follow.storage.mockImplementation(() => Promise.reject(new OperationLimitError()));

      // When
      const read = readSlotAt(api, 0).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await read;

      // Then
      expect(error).toBeInstanceOf(OperationLimitError);
    });
  });

  describe('the end of the chain follow', () => {
    it('As a resolver whose stop listener throws, I am reported and the next stop listener still hears the stop', () => {
      // Given
      const captured = recordReports({ onFinished: onTestFinished }).exceptions;
      const metrics = bindRecordingSentry({ onFinished: onTestFinished });
      const { client, follow } = createFakeSubstrateClient();
      const api = createRawApi({ client });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      api.onStop(() => {
        throw new TypeError('listener broke');
      });
      let heard = 0;
      api.onStop(() => {
        heard += 1;
      });

      // When
      follow.stop();

      // Then
      expect(heard).toBe(1);
      expect(captured).toMatchObject([{ step: 'listener', tags: { owner: 'resolver.stop' } }]);
      expect(metrics.counted('listener.delivery')).toEqual([
        { outcome: 'error', reason: 'TypeError', owner: 'resolver.stop' },
      ]);
    });

    it('As a stop listener that subscribes after the follow stopped and throws, I am reported and my registration returns', () => {
      // Given
      const captured = recordReports({ onFinished: onTestFinished }).exceptions;
      const { client, follow } = createFakeSubstrateClient();
      const api = createRawApi({ client });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      follow.stop();

      // When
      const error = catchError(() =>
        api.onStop(() => {
          throw new TypeError('late listener broke');
        }),
      );

      // Then
      expect(error).toBeUndefined();
      expect(captured).toMatchObject([{ step: 'listener', tags: { owner: 'resolver.stop' } }]);
    });
  });

  it('As the resolver, I destroy the raw API twice before its follow is ready and the wait fails as stopped and stop listeners hear it once', async () => {
    // Given
    const { client } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    const waited = api.whenReady().then(
      () => undefined,
      (error: unknown) => error,
    );
    let heard = 0;
    api.onStop(() => {
      heard += 1;
    });

    // When
    api.destroy();
    api.destroy();

    // Then
    expect(await waited).toBeInstanceOf(ApiStoppedError);
    expect(heard).toBe(1);
  });

  it('As a dotli user, I let finality move on after the follow stopped and the refused unpin is not reported', async () => {
    // Given
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { client, follow } = createFakeSubstrateClient();
    const refused = Promise.reject(new DisjointError());
    follow.unpin.mockImplementation(() => refused);
    createRawApi({ client });

    // When finality leaves a block behind
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x00', '0x0a'] });
    await refused.catch(() => undefined);

    // Then
    expect(captured).toEqual([]);
    expect(metrics.counted('resolve.unpin')).toEqual([]);
  });

  it('As an operator, I see an unpin the light client refuses while the follow runs reported and counted', async () => {
    // Given
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { client, follow } = createFakeSubstrateClient();
    const refused = Promise.reject(new TypeError('Invalid block hash'));
    follow.unpin.mockImplementation(() => refused);
    createRawApi({ client });

    // When finality leaves a block behind
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x00', '0x0a'] });
    await refused.catch(() => undefined);

    // Then
    expect(captured).toMatchObject([{ step: 'unpin', tags: undefined }]);
    expect(metrics.counted('resolve.unpin')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });
});

/** Reads slot `index` pinned to `0x0a` with a known trie id, so the read is exactly one storage call. */
function readSlotAt(api: Api, index: number): Promise<Uint8Array | null> {
  const slotKey: `0x${string}` = `0x${index.toString(16).padStart(64, '0')}`;
  return api.readSlot(CONTRACT_ADDRESS, slotKey, { atHash: '0x0a', trieId: new Uint8Array([1]) });
}
