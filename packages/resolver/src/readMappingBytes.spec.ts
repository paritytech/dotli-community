// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@dotli/shared';
import { OperationInaccessibleError } from '@polkadot-api/substrate-client';
import { CorruptBytesSlotError } from './corruptBytesSlotError.js';
import { createRawApi, type Api } from './createRawApi.js';
import { PartialStorageReadError } from './partialStorageReadError.js';
import { readMappingBytes } from './readMappingBytes.js';
import { CONTRACT_ACCOUNT_INFO, CONTRACT_ADDRESS } from './testing/constants.js';
import { createFakeSubstrateClient, type FakeFollow } from './testing/createFakeSubstrateClient.js';
import { createNewBlockEvent } from './testing/createNewBlockEvent.js';

describe('readMappingBytes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a dotli user on a freshly synced light client, I read a name the node cannot serve yet and the read is retried until it answers', async () => {
    // Given
    vi.useFakeTimers();
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    follow.storage
      .mockImplementationOnce(() => Promise.reject(new OperationInaccessibleError()))
      .mockImplementationOnce(() => Promise.resolve(CONTRACT_ACCOUNT_INFO))
      .mockImplementationOnce(() => Promise.reject(new OperationInaccessibleError()))
      .mockImplementationOnce(() => Promise.resolve(`0x01${'00'.repeat(30)}02`));

    // When
    const read = readMappingBytes({
      api,
      contractAddress: CONTRACT_ADDRESS,
      mappingKey: `0x${'00'.repeat(32)}`,
      mappingSlot: 0,
    });
    await vi.runAllTimersAsync();
    const bytes = await read;

    // Then
    expect(bytes).toEqual(new Uint8Array([0x01]));
    expect(follow.storage).toHaveBeenCalledTimes(4);
  });

  it('As a dotli user on a light client, I read a long value whose second data slot is gone and the read fails as a partial read', async () => {
    // Given a 64-byte value, which keeps `64 * 2 + 1` in its own slot and spans two data slots
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    follow.storage
      .mockImplementationOnce(() => Promise.resolve(CONTRACT_ACCOUNT_INFO))
      .mockImplementationOnce(() => Promise.resolve(`0x${'00'.repeat(31)}81`))
      .mockImplementationOnce(() => Promise.resolve(`0x${'ab'.repeat(32)}`))
      .mockImplementationOnce(() => Promise.resolve(null));

    // When
    const read = readMappingBytes({
      api,
      contractAddress: CONTRACT_ADDRESS,
      mappingKey: `0x${'00'.repeat(32)}`,
      mappingSlot: 0,
    });

    // Then
    await expect(read).rejects.toBeInstanceOf(PartialStorageReadError);
    await expect(read).rejects.toHaveProperty('context', { mappingKind: 'mapping bytes' });
  });

  it('As a dotli user on a light client, I read a value whose slot claims a length no read can hold and the read fails as a corrupt slot', async () => {
    // Given a base slot that decodes to a length whose slot count passes the largest array length
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    follow.storage
      .mockImplementationOnce(() => Promise.resolve(CONTRACT_ACCOUNT_INFO))
      .mockImplementationOnce(() => Promise.resolve(`0x${'ff'.repeat(32)}`));

    // When
    const read = readMappingBytes({
      api,
      contractAddress: CONTRACT_ADDRESS,
      mappingKey: `0x${'00'.repeat(32)}`,
      mappingSlot: 0,
    });

    // Then
    await expect(read).rejects.toBeInstanceOf(CorruptBytesSlotError);
  });

  it('As a dotli user on a light client, I read a long value and every data slot is asked before any answers', async () => {
    // Given a 96-byte value whose three data slots each wait for the test to answer
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    const thirdAsked = createDeferred<undefined>();
    const slots = [
      createDeferred<string | null>(),
      createDeferred<string | null>(),
      createDeferred<string | null>(),
    ] as const;
    answerLongValueBase(follow)
      .mockImplementationOnce(() => slots[0].promise)
      .mockImplementationOnce(() => slots[1].promise)
      .mockImplementationOnce(() => {
        thirdAsked.resolve(undefined);
        return slots[2].promise;
      });

    // When
    const read = readLongValue(api);
    await thirdAsked.promise;
    const storageCallsBeforeAnswers = follow.storage.mock.calls.length;
    slots[0].resolve(`0x${'01'.repeat(32)}`);
    slots[1].resolve(`0x${'02'.repeat(32)}`);
    slots[2].resolve(`0x${'03'.repeat(32)}`);
    const bytes = await read;

    // Then
    expect(storageCallsBeforeAnswers).toBe(5);
    expect(bytes).toEqual(
      new Uint8Array([
        ...new Array<number>(32).fill(1),
        ...new Array<number>(32).fill(2),
        ...new Array<number>(32).fill(3),
      ]),
    );
  });

  it('As a dotli user on a light client, I read a long value whose second data slot fails before an unset third and the read fails with the second slot error', async () => {
    // Given a 96-byte value whose lowest failing data slot rejects
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    const slotError = new Error('slot 1 failed');
    answerLongValueBase(follow)
      .mockImplementationOnce(() => Promise.resolve(`0x${'01'.repeat(32)}`))
      .mockImplementationOnce(() => Promise.reject(slotError))
      .mockImplementationOnce(() => Promise.resolve(null));

    // When
    const read = readLongValue(api);

    // Then
    await expect(read).rejects.toBe(slotError);
  });

  it('As a dotli user on a light client, I read a long value whose second data slot is unset before a failing third and the read fails as a partial read at the second slot', async () => {
    // Given a 96-byte value whose lowest failing data slot is unset
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    answerLongValueBase(follow)
      .mockImplementationOnce(() => Promise.resolve(`0x${'01'.repeat(32)}`))
      .mockImplementationOnce(() => Promise.resolve(null))
      .mockImplementationOnce(() => Promise.reject(new Error('slot 2 failed')));

    // When
    const read = readLongValue(api);

    // Then
    await expect(read).rejects.toBeInstanceOf(PartialStorageReadError);
    await expect(read).rejects.toMatchObject({ slotIndex: 1, slotsExpected: 3 });
  });

  it('As a dotli user on a light client, I read a long value whose first data slot fails and the block stays pinned until the last slot settles', async () => {
    // Given a 96-byte value whose first data slot fails at once and whose last one waits for the test to answer
    vi.useFakeTimers();
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    const slotError = new Error('slot 0 failed');
    const lastAsked = createDeferred<undefined>();
    const lastSlot = createDeferred<string | null>();
    answerLongValueBase(follow)
      .mockImplementationOnce(() => Promise.reject(slotError))
      .mockImplementationOnce(() => Promise.resolve(`0x${'02'.repeat(32)}`))
      .mockImplementationOnce(() => {
        lastAsked.resolve(undefined);
        return lastSlot.promise;
      });
    const read = readLongValue(api);
    await lastAsked.promise;
    // The first slot's failure reaches every waiting step before finality moves on.
    await vi.advanceTimersByTimeAsync(0);

    // When
    follow.emit(createNewBlockEvent('0x1a', '0x0a'));
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x1a'], prunedBlockHashes: [] });
    const unpinnedWhileHeld = [...follow.unpin.mock.calls];
    lastSlot.resolve(`0x${'03'.repeat(32)}`);
    const error = await read.catch((caught: unknown) => caught);

    // Then
    expect(unpinnedWhileHeld).toEqual([]);
    expect(error).toBe(slotError);
    expect(follow.unpin.mock.calls).toEqual([[['0x0a']]]);
  });
});

/** Answers the contract's account info and the base slot of a 96-byte value, which keeps `96 * 2 + 1` there. */
function answerLongValueBase(follow: FakeFollow): FakeFollow['storage'] {
  return follow.storage
    .mockImplementationOnce(() => Promise.resolve(CONTRACT_ACCOUNT_INFO))
    .mockImplementationOnce(() => Promise.resolve(`0x${'00'.repeat(31)}c1`));
}

function readLongValue(api: Api): Promise<Uint8Array | null> {
  return readMappingBytes({
    api,
    contractAddress: CONTRACT_ADDRESS,
    mappingKey: `0x${'00'.repeat(32)}`,
    mappingSlot: 0,
  });
}
