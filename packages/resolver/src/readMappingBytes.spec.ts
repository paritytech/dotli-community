// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationInaccessibleError } from '@polkadot-api/substrate-client';
import { createRawApi } from './createRawApi.js';
import { PartialStorageReadError } from './partialStorageReadError.js';
import { readMappingBytes } from './readMappingBytes.js';
import { CONTRACT_ACCOUNT_INFO } from './testing/constants.js';
import { createFakeSubstrateClient } from './testing/createFakeSubstrateClient.js';
import { createNewBlockEvent } from './testing/createNewBlockEvent.js';
import { holdSlotAnswer } from './testing/holdSlotAnswer.js';

describe('readMappingBytes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a dotli user on a light client, I read a name's bytes over several slots and the block stays pinned while finality moves on", async () => {
    // Given
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    const { slotAsked, answerSlot } = holdSlotAnswer(follow);
    const read = readMappingBytes({
      api,
      contractAddress: '0x0000000000000000000000000000000000000001',
      mappingKey: `0x${'00'.repeat(32)}`,
      mappingSlot: 0,
    });
    await slotAsked;
    const storageCallsBeforeFinality = follow.storage.mock.calls.length;

    // When
    follow.emit(createNewBlockEvent('0x1a', '0x0a'));
    follow.emit({ type: 'finalized', finalizedBlockHashes: ['0x1a'], prunedBlockHashes: [] });
    const unpinnedDuringRead = [...follow.unpin.mock.calls];
    answerSlot();
    await read;

    // Then
    expect(storageCallsBeforeFinality).toBe(2);
    expect(unpinnedDuringRead).toEqual([]);
    expect(follow.storage.mock.calls.map(([hash]) => hash)).toEqual(['0x0a', '0x0a']);
    expect(follow.unpin.mock.calls).toEqual([[['0x0a']]]);
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
      contractAddress: '0x0000000000000000000000000000000000000001',
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
      contractAddress: '0x0000000000000000000000000000000000000001',
      mappingKey: `0x${'00'.repeat(32)}`,
      mappingSlot: 0,
    });

    // Then
    await expect(read).rejects.toBeInstanceOf(PartialStorageReadError);
    await expect(read).rejects.toHaveProperty('context', { mappingKind: 'mapping bytes' });
  });
});
