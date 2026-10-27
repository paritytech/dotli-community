// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createRawApi } from './createRawApi.js';
import { readMappingAddress } from './readMappingAddress.js';
import { createFakeSubstrateClient } from './testing/createFakeSubstrateClient.js';
import { createNewBlockEvent } from './testing/createNewBlockEvent.js';
import { holdSlotAnswer } from './testing/holdSlotAnswer.js';

describe('readMappingAddress', () => {
  it("As a dotli user on a light client, I look up a name's owner and the block stays pinned while finality moves on", async () => {
    // Given
    const { client, follow } = createFakeSubstrateClient();
    const api = createRawApi({ client });
    follow.emit({ type: 'initialized', finalizedBlockHashes: ['0x0a'] });
    const { slotAsked, answerSlot } = holdSlotAnswer(follow);
    const read = readMappingAddress({
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
    expect(follow.unpin.mock.calls).toEqual([[['0x0a']]]);
  });
});
