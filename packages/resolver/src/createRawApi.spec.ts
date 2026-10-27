// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DisjointError, OperationInaccessibleError } from '@polkadot-api/substrate-client';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { catchError } from '@dotli/shared/testing';
import { ApiStoppedError } from './apiStoppedError.js';
import { createRawApi } from './createRawApi.js';
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

    it('As a dotli user on a light client that never serves a read, I read a slot and the read fails instead of retrying forever', async () => {
      // Given
      const { client, follow } = createFakeSubstrateClient();
      const api = createRawApi({ client });
      follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
      follow.storage.mockImplementation(() => Promise.reject(new OperationInaccessibleError()));

      // When
      const read = api
        .resolveTrieId('0x0000000000000000000000000000000000000001', '0x0a')
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await read;

      // Then
      expect(error).toBeInstanceOf(OperationInaccessibleError);
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
      const read = api
        .resolveTrieId('0x0000000000000000000000000000000000000001', '0x0a')
        .catch((error: unknown) => error);
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
      const read = api
        .resolveTrieId('0x0000000000000000000000000000000000000001', '0x0a')
        .catch((error: unknown) => error);
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

  describe('the end of the chain follow', () => {
    it('As a resolver whose stop listener throws, I am reported and the next stop listener still hears the stop', () => {
      // Given
      const captured = recordCaptures({ onFinished: onTestFinished });
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
      expect(captured).toEqual([{ flow: 'resolve', step: 'listener', tags: { owner: 'resolver.stop' } }]);
      expect(metrics.counted('listener.delivery')).toEqual([
        { outcome: 'error', reason: 'TypeError', owner: 'resolver.stop' },
      ]);
    });

    it('As a stop listener that subscribes after the follow stopped and throws, I am reported and my registration returns', () => {
      // Given
      const captured = recordCaptures({ onFinished: onTestFinished });
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
      expect(captured).toEqual([{ flow: 'resolve', step: 'listener', tags: { owner: 'resolver.stop' } }]);
    });
  });

  it('As a dotli user, I let finality move on after the follow stopped and the refused unpin is not reported', async () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
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
    expect(metrics.counted(S.RESOLVE_UNPIN)).toEqual([]);
  });

  it('As an operator, I see an unpin the light client refuses while the follow runs reported and counted', async () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { client, follow } = createFakeSubstrateClient();
    const refused = Promise.reject(new TypeError('Invalid block hash'));
    follow.unpin.mockImplementation(() => refused);
    createRawApi({ client });

    // When finality leaves a block behind
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x00', '0x0a'] });
    await refused.catch(() => undefined);

    // Then
    expect(captured).toEqual([{ flow: 'resolve', step: 'unpin', tags: undefined }]);
    expect(metrics.counted(S.RESOLVE_UNPIN)).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });
});
