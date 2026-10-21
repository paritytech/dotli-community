// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createFollowSnapshot } from './follow-snapshot.js';

describe('createFollowSnapshot', () => {
  it('As a session joining a shared follow late, I am replayed the newest finalized block, the blocks up to the best one and the best block', () => {
    // Given a follow with an initialized base, two blocks and a best block
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: { spec: 1 } });
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    snapshot.record({ event: 'newBlock', blockHash: '0xb2', parentBlockHash: '0xb1' });
    snapshot.record({ event: 'bestBlockChanged', bestBlockHash: '0xb2' });

    // When the late session asks for its replay
    const replay = snapshot.replayFor('late');

    // Then it gets the base, both blocks and the best block
    expect(replay).toEqual([
      { event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: { spec: 1 } },
      { event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' },
      { event: 'newBlock', blockHash: '0xb2', parentBlockHash: '0xb1' },
      { event: 'bestBlockChanged', bestBlockHash: '0xb2' },
    ]);
  });

  it('As a session joining before the node said initialized, I am replayed nothing', () => {
    // Given a snapshot with nothing recorded
    const snapshot = createFollowSnapshot();

    // When the early session asks for its replay
    const replay = snapshot.replayFor('early');

    // Then the session is replayed nothing
    expect(replay).toEqual([]);
  });

  it('As a session joining after a runtime upgrade was finalized, I am replayed the upgraded runtime', () => {
    // Given a follow initialized, then a block that upgrades the runtime and is finalized
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: { spec: 1 } });
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0', newRuntime: { spec: 2 } });
    snapshot.record({ event: 'finalized', finalizedBlockHashes: ['0xb1'], prunedBlockHashes: [] });

    // When the late session asks for its replay
    const [initialized] = snapshot.replayFor('late');

    // Then the initialized event carries the upgraded runtime
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

  it('As a session joining a follow on a fork, I am replayed every unfinalized block, parents first', () => {
    // Given two branches above the finalized block
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    snapshot.record({ event: 'newBlock', blockHash: '0xa1', parentBlockHash: '0xf0' });
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    snapshot.record({ event: 'newBlock', blockHash: '0xa2', parentBlockHash: '0xa1' });
    snapshot.record({ event: 'bestBlockChanged', bestBlockHash: '0xa2' });

    // When the late session asks for its replay
    const replay = snapshot.replayFor('late');

    // Then it is replayed every unfinalized block on both branches, parents first
    expect(replay).toEqual([
      { event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: null },
      { event: 'newBlock', blockHash: '0xa1', parentBlockHash: '0xf0' },
      { event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' },
      { event: 'newBlock', blockHash: '0xa2', parentBlockHash: '0xa1' },
      { event: 'bestBlockChanged', bestBlockHash: '0xa2' },
    ]);
  });

  it('As a session joining before any best block was reported, I am still replayed the unfinalized blocks', () => {
    // Given a finalized base and one unfinalized block, with no best block reported
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });

    // When the late session asks for its replay
    const replay = snapshot.replayFor('late');

    // Then it is replayed the base and the unfinalized block
    expect(replay).toEqual([
      { event: 'initialized', finalizedBlockHashes: ['0xf0'], finalizedBlockRuntime: null },
      { event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' },
    ]);
  });

  it('As a session joining after a fork was pruned, I am replayed only the blocks that survived', () => {
    // Given a fork that finalization pruned
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    snapshot.record({ event: 'newBlock', blockHash: '0xa1', parentBlockHash: '0xf0' });
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    snapshot.record({ event: 'newBlock', blockHash: '0xa2', parentBlockHash: '0xa1' });
    snapshot.record({ event: 'bestBlockChanged', bestBlockHash: '0xa2' });
    snapshot.record({ event: 'finalized', finalizedBlockHashes: ['0xa1'], prunedBlockHashes: ['0xb1'] });

    // When the late session asks for its replay
    const replay = snapshot.replayFor('late');

    // Then it is replayed the new base, the surviving block and the best block
    expect(replay).toEqual([
      { event: 'initialized', finalizedBlockHashes: ['0xa1'], finalizedBlockRuntime: null },
      { event: 'newBlock', blockHash: '0xa2', parentBlockHash: '0xa1' },
      { event: 'bestBlockChanged', bestBlockHash: '0xa2' },
    ]);
  });

  it('As a session joining a follow whose node announced blocks before initialized, I am replayed nothing and hold no pins', () => {
    // Given a node that broke the protocol and announced blocks with no finalized base
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    snapshot.record({ event: 'bestBlockChanged', bestBlockHash: '0xb1' });

    // When the late session asks for its replay
    const replay = snapshot.replayFor('late');

    // Then there is no base to replay from, and nothing pinned for the session to release
    expect(replay).toEqual([]);
    expect(snapshot.release('late', null)).toEqual([]);
  });

  it('As the broker, I hear a pruned block as orphaned only when no session pins it', () => {
    // Given a session told of the finalized block and one of two forks
    const snapshot = createFollowSnapshot();
    const initialized = { event: 'initialized', finalizedBlockHashes: ['0xf0'] };
    const pinnedFork = { event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' };
    snapshot.record(initialized);
    snapshot.pinEvent('a', initialized);
    snapshot.record({ event: 'newBlock', blockHash: '0xa1', parentBlockHash: '0xf0' });
    snapshot.record(pinnedFork);
    snapshot.pinEvent('a', pinnedFork);
    snapshot.record({ event: 'newBlock', blockHash: '0xc1', parentBlockHash: '0xf0' });

    // When finalization prunes both forks
    const orphaned = snapshot.record({
      event: 'finalized',
      finalizedBlockHashes: ['0xa1'],
      prunedBlockHashes: ['0xb1', '0xc1'],
    });

    // Then only the fork no session pins is orphaned
    expect(orphaned).toEqual(['0xc1']);
  });

  it('As a session replayed a fork, I free my pin on it when I release it', () => {
    // Given a session replayed a side fork that finalization then pruned
    const snapshot = createFollowSnapshot();
    snapshot.record({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    snapshot.record({ event: 'newBlock', blockHash: '0xa1', parentBlockHash: '0xf0' });
    snapshot.record({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    snapshot.record({ event: 'bestBlockChanged', bestBlockHash: '0xa1' });
    snapshot.replayFor('late');
    const onFinalized = snapshot.record({
      event: 'finalized',
      finalizedBlockHashes: ['0xa1'],
      prunedBlockHashes: ['0xb1'],
    });

    // When the session releases the fork
    const released = snapshot.release('late', ['0xb1']);

    // Then the fork stayed pinned for the session until then, and its release orphans it
    expect(onFinalized).toEqual([]);
    expect(released).toEqual(['0xb1']);
  });
});
