// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createFollowSnapshot } from './follow-snapshot.js';

describe('createFollowSnapshot', () => {
  it('As a session joining a shared follow late, I am replayed the newest finalized block, the blocks up to the best one and the best block', () => {
    // Given
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: { spec: 1 } });
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    snapshot.record({ event: 'newBlock', blockHash: '0xb2', parentBlockHash: '0xb1' });
    snapshot.record({ event: 'bestBlockChanged', bestBlockHash: '0xb2' });

    // When
    const replay = snapshot.replayFor('late');

    // Then
    expect(replay).toEqual([
      { event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: { spec: 1 } },
      { event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' },
      { event: 'newBlock', blockHash: '0xb2', parentBlockHash: '0xb1' },
      { event: 'bestBlockChanged', bestBlockHash: '0xb2' },
    ]);
  });

  it('As a session joining before the node said initialized, I am replayed nothing', () => {
    // Given
    const snapshot = createFollowSnapshot();

    // When
    const replay = snapshot.replayFor('early');

    // Then
    expect(replay).toEqual([]);
  });

  it('As a session joining after a runtime upgrade was finalized, I am replayed the upgraded runtime', () => {
    // Given
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: { spec: 1 } });
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0', newRuntime: { spec: 2 } });
    snapshot.record({ event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: [] });

    // When
    const [initialized] = snapshot.replayFor('late');

    // Then
    expect(initialized).toEqual({
      event: 'initialized',
      finalizedBlockHashes: ['0xb1'],
      finalizedBlockRuntime: { spec: 2 },
    });
  });

  it('As the broker, I hear a block finalized past as orphaned only once no session pins it', () => {
    // Given two sessions told of the first finalized block
    const snapshot = createFollowSnapshot();
    const initialized = { event: 'initialized', finalizedBlockHashes: ['0xf0'] };
    snapshot.record(initialized);
    snapshot.pinEvent('a', initialized);
    snapshot.pinEvent('b', initialized);
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });

    // When the chain finalizes past it and the sessions unpin it in turn
    const onFinalized = snapshot.record({ event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: [] });
    const afterA = snapshot.release('a', ['0xf0']);
    const afterB = snapshot.release('b', ['0xf0']);

    // Then only the last release orphans it
    expect(onFinalized).toEqual([]);
    expect(afterA).toEqual([]);
    expect(afterB).toEqual(['0xf0']);
  });

  it('As a session joining late, I keep the blocks I am replayed pinned until I release them', () => {
    // Given a session replayed the first finalized block as its base
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    snapshot.replayFor('late');

    // When the chain finalizes past that base
    const onFinalized = snapshot.record({ event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: [] });

    // Then the base stays pinned for the session until it lets go of everything
    expect(onFinalized).toEqual([]);
    expect(snapshot.release('late', null)).toEqual(['0xf0']);
  });
});
