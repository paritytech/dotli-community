// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import type { ChainActivity } from '@dotli/chains';
import {
  classifyGap,
  createNetworkMonitorState,
  MAX_BARS,
  type ChainPhase,
  type ChainStatus,
  type NetworkMonitor,
} from './networkMonitorState.js';
import { describeLiveNetwork } from '../networkVerdict.js';
import { buildChainActivity } from '../testing/buildChainActivity.js';
import { getRelayGenesis } from '../testing/getRelayGenesis.js';
import { recordNotified } from '../testing/recordNotified.js';
import { createManualTimers, must, nth, type ManualTimers } from '@dotli/shared/testing';

const EXTRA = `0x${'ab'.repeat(32)}`;

/** Chains the active network offers no endpoint for, by lowercase genesis. */
const unreachable = new Set<string>();
let monitor: NetworkMonitor;
let timers: ManualTimers;

beforeEach(() => {
  unreachable.clear();
  timers = createManualTimers();
  monitor = createNetworkMonitorState({ isConnectable: genesis => !unreachable.has(genesis.toLowerCase()), timers });
});

describe('Block arrival colouring works', () => {
  it.each([
    { gapMs: 6000, blockTimeMs: 6000, health: 'onTime' },
    { gapMs: 9000, blockTimeMs: 6000, health: 'onTime' },
    { gapMs: 9001, blockTimeMs: 6000, health: 'late' },
    { gapMs: 18_000, blockTimeMs: 6000, health: 'late' },
    { gapMs: 18_001, blockTimeMs: 6000, health: 'veryLate' },
    { gapMs: 6000, blockTimeMs: 2000, health: 'late' },
    { gapMs: 6001, blockTimeMs: 2000, health: 'veryLate' },
  ])(
    'As a user, I get a block $gapMs ms after the last on a $blockTimeMs ms chain and see it read $health',
    ({ gapMs, blockTimeMs, health }) => {
      // When
      const judged = classifyGap(gapMs, blockTimeMs);

      // Then
      expect(judged).toBe(health);
    },
  );
});

describe('The network monitor tracks blocks', () => {
  it('As a user, I open the panel and see every known chain of my network listed and unused', () => {
    // When
    const chains = monitor.getNetworkStatus();

    // Then
    expect(chains.map(chain => [chain.key, chain.label, chain.state])).toEqual([
      ['relay', 'Relay', 'unused'],
      ['assethub', 'Hub', 'unused'],
      ['bulletin', 'Storage', 'unused'],
      ['people', 'Identity', 'unused'],
    ]);
  });

  it('As a user, I get a block on a chain nobody uses and see no block recorded', () => {
    // When
    monitor.recordBestBlock(getRelayGenesis(), 100);

    // Then
    expect(getChainByKey('relay').latest).toBeNull();
  });

  it('As a user, I hold a chain the pool names in lowercase and see it land on its known row', () => {
    // When
    use(getRelayGenesis().toUpperCase().replace(/^0X/, '0x'));
    use(getRelayGenesis().toLowerCase());

    // Then
    expect(monitor.getNetworkStatus()).toHaveLength(4);
    expect(getChainByKey('relay').state).not.toBe('unused');
  });

  it('As a user, I stop using a known chain and see it keep its bars and stop its clock', async () => {
    // Given
    use(getRelayGenesis());
    monitor.recordBestBlock(getRelayGenesis(), 100);
    await timers.advance(6000);
    monitor.recordBestBlock(getRelayGenesis(), 101);

    // When
    release(getRelayGenesis());

    // Then
    expect(getChainByKey('relay')).toMatchObject({ latest: 101, sinceLast: null, state: 'unused' });
    expect(getChainByKey('relay').bars.map(bar => bar.number)).toEqual([101]);
  });

  it('As a user, I hold a chain again and see it carry on from its next block, with no bar for the time it was unused', async () => {
    // Given
    use(getRelayGenesis());
    monitor.recordBestBlock(getRelayGenesis(), 100);
    await timers.advance(6000);
    monitor.recordBestBlock(getRelayGenesis(), 101);
    release(getRelayGenesis());
    await timers.advance(60_000);

    // When
    use(getRelayGenesis());
    const heldAgain = getChainByKey('relay');
    monitor.recordBestBlock(getRelayGenesis(), 120);

    // Then
    expect(heldAgain).toMatchObject({ state: 'pending', alarm: false });
    expect(getChainByKey('relay')).toMatchObject({ latest: 120, state: 'live' });
    expect(getChainByKey('relay').bars.map(bar => bar.number)).toEqual([101]);
  });

  it('As a user of a product on another chain, I hold that chain and see it listed while in use and gone after', () => {
    // When
    use(EXTRA);
    const listed = getChainByKey(EXTRA);
    release(EXTRA);

    // Then
    expect(listed).toMatchObject({
      role: null,
      label: '0xabab…abab',
      blockTimeMs: 6000,
      reachable: true,
    });
    expect(monitor.getNetworkStatus().some(chain => chain.key === EXTRA)).toBe(false);
  });

  it('As a user, I release a chain never held and never see it listed', () => {
    // When
    release(EXTRA);

    // Then
    expect(monitor.getNetworkStatus()).toHaveLength(4);
  });

  it('As a user watching a chain, I get its first block as the anchor and see bars for later ones', async () => {
    // Given
    use(getRelayGenesis());
    const relay = nth(monitor.getNetworkStatus(), 0);
    const genesis = getRelayGenesis();

    // When
    monitor.recordBestBlock(genesis, 100);
    const anchored = nth(monitor.getNetworkStatus(), 0);
    await timers.advance(relay.blockTimeMs);
    monitor.recordBestBlock(genesis, 101);

    // Then
    expect(anchored.bars.length).toBe(0);
    expect(anchored.latest).toBe(100);
    expect(monitor.getNetworkStatus()[0]?.bars).toEqual([{ number: 101, health: 'onTime', gapMs: relay.blockTimeMs }]);
  });

  it('As a user holding a snapshot of the panel, I get later blocks and see its bars stay as they were', async () => {
    // Given
    use(getRelayGenesis());
    const relay = nth(monitor.getNetworkStatus(), 0);
    const genesis = getRelayGenesis();
    monitor.recordBestBlock(genesis, 100);
    await timers.advance(relay.blockTimeMs);
    monitor.recordBestBlock(genesis, 101);
    const held = nth(monitor.getNetworkStatus(), 0).bars;

    // When
    await timers.advance(relay.blockTimeMs);
    monitor.recordBestBlock(genesis, 102);

    // Then
    expect(held.map(bar => bar.number)).toEqual([101]);
    expect(Object.isFrozen(held)).toBe(true);
    expect(monitor.getNetworkStatus()[0]?.bars.map(bar => bar.number)).toEqual([101, 102]);
  });

  it('As a user on a degraded chain, I get a slow block and see its bar is not green', async () => {
    // Given
    use(getRelayGenesis());
    const genesis = getRelayGenesis();
    monitor.recordBestBlock(genesis, 1);

    // When
    await timers.advance(60_000);
    monitor.recordBestBlock(genesis, 2);

    // Then
    expect(monitor.getNetworkStatus()[0]?.bars[0]?.health).toBe('veryLate');
  });

  it('As a user with the panel open all day, I keep getting blocks and see memory stay bounded', async () => {
    // Given
    use(getRelayGenesis());
    const genesis = getRelayGenesis();

    // When
    for (let blockNumber = 0; blockNumber < MAX_BARS + 15; blockNumber += 1) {
      await timers.advance(6000);
      monitor.recordBestBlock(genesis, blockNumber);
    }

    // Then
    expect(monitor.getNetworkStatus()[0]?.bars.length).toBe(MAX_BARS);
  });

  it('As a user who kept the panel open, I get 61 blocks and see every block after the first stay as a bar', async () => {
    // Given
    use(getRelayGenesis());
    const genesis = getRelayGenesis();

    // When the first block only sets the baseline
    for (let blockNumber = 0; blockNumber < 61; blockNumber += 1) {
      await timers.advance(6000);
      monitor.recordBestBlock(genesis, blockNumber);
    }

    // Then
    expect(monitor.getNetworkStatus()[0]?.bars.length).toBe(60);
  });

  it('As a user on a chain that republishes its head, I get one block three times and see one bar', async () => {
    // Given
    use(getRelayGenesis());
    const genesis = getRelayGenesis();

    // When
    await timers.advance(6000);
    monitor.recordBestBlock(genesis, 100);
    await timers.advance(6000);
    monitor.recordBestBlock(genesis, 101);
    monitor.recordBestBlock(genesis, 101);
    monitor.recordBestBlock(genesis, 101);
    await timers.advance(6000);
    monitor.recordBestBlock(genesis, 102);

    // Then
    expect(nth(monitor.getNetworkStatus(), 0).bars.map(bar => bar.number)).toEqual([101, 102]);
  });

  it('As a user whose chain reorgs to an earlier block, I watch the strip and see it not go backwards', async () => {
    // Given
    use(getRelayGenesis());
    const genesis = getRelayGenesis();

    // When
    await timers.advance(6000);
    monitor.recordBestBlock(genesis, 200);
    await timers.advance(6000);
    monitor.recordBestBlock(genesis, 201);
    await timers.advance(6000);
    monitor.recordBestBlock(genesis, 199);

    // Then
    expect(monitor.getNetworkStatus()[0]?.bars.map(bar => bar.number)).toEqual([201]);
  });

  it('As a user on a network missing an endpoint, I hold that chain and see it unreachable and never in use', () => {
    // Given
    unreachable.add(getRelayGenesis().toLowerCase());

    // When
    use(getRelayGenesis());

    // Then
    expect(getChainByKey('relay')).toMatchObject({ reachable: false, state: 'unused' });
  });

  it('As a user with the panel open, I get a block and see it the moment it lands, and nothing once the panel closes', () => {
    // Given
    use(getRelayGenesis());
    let calls = 0;
    const unsubscribe = monitor.version.listen(() => {
      calls += 1;
    });

    // When a block lands, the panel closes, and another block lands
    monitor.recordBestBlock(getRelayGenesis(), 7);
    unsubscribe();
    monitor.recordBestBlock(getRelayGenesis(), 8);

    // Then
    expect(calls).toBe(1);
  });

  it('As a user hovering a bar, I read the gap that produced it and see it recorded', async () => {
    // Given
    use(getRelayGenesis());
    const genesis = getRelayGenesis();
    monitor.recordBestBlock(genesis, 1);

    // When
    await timers.advance(15_000);
    monitor.recordBestBlock(genesis, 2);

    // Then
    expect(monitor.getNetworkStatus()[0]?.bars[0]?.gapMs).toBe(15_000);
  });
});

describe('The network monitor tracks peers', () => {
  it('As a user, I open the panel before any sample and see no chain claim a peer count', () => {
    // When
    const chains = monitor.getNetworkStatus();

    // Then
    expect(chains.map(c => c.peers)).toEqual([null, null, null, null]);
  });

  it('As a user watching the panel, I get peer samples and see each chain report the peers it actually holds', () => {
    // When
    monitor.recordPeerCount('relay', 7);
    monitor.recordPeerCount('assethub', 3);
    const byRole = new Map(monitor.getNetworkStatus().map(c => [c.role, c.peers]));

    // Then
    expect({ relay: byRole.get('relay'), assethub: byRole.get('assethub'), people: byRole.get('people') }).toEqual({
      relay: 7,
      assethub: 3,
      people: null,
    });
  });
});

describe('The network monitor tracks the connection', () => {
  it('As a user, I open the panel before anything moves and see nothing claimed about the connection', () => {
    // When
    const transfer = monitor.getTransfer();

    // Then
    expect(transfer).toEqual({
      bytesPerSecond: null,
      fetched: null,
      total: null,
    });
  });

  it('As a user watching a download, I get a new speed and see the progress survive it', () => {
    // Given
    monitor.recordTransfer({ bytesPerSecond: 962_560 });
    monitor.recordTransfer({ fetched: 6_400_000, total: 14_600_000 });

    // When
    monitor.recordTransfer({ bytesPerSecond: 1_010_000 });

    // Then
    expect(monitor.getTransfer()).toEqual({
      bytesPerSecond: 1_010_000,
      fetched: 6_400_000,
      total: 14_600_000,
    });
  });

  it('As a user on a load that declared no size, I watch it download and see no progress invented', () => {
    // When
    monitor.recordTransfer({ fetched: 900_000, total: null });

    // Then
    expect(monitor.getTransfer().total).toBeNull();
  });
});

describe('The network monitor tracks the phase of each chain', () => {
  it('As a user, I open the panel before the light client speaks and see no phase claimed', () => {
    // When
    const chains = monitor.getNetworkStatus();

    // Then
    expect(chains.map(c => c.phase)).toEqual([null, null, null, null]);
  });

  it('As a user watching a chain come up, I get each phase and see the panel follow it through to ready', () => {
    // Given
    const phases: ChainPhase[] = ['connecting', 'syncing', 'ready'];
    const seen: (ChainPhase | null | undefined)[] = [];

    // When
    for (const phase of phases) {
      monitor.recordChainPhase('relay', phase);
      seen.push(monitor.getNetworkStatus().find(c => c.role === 'relay')?.phase);
    }

    // Then
    expect(seen).toEqual(['connecting', 'syncing', 'ready']);
  });
});

describe('The network monitor repaints the panel only on a change', () => {
  it('As a follower, I hear the version bump once per changed record, and not for an unchanged one', () => {
    // Given
    const versions = recordNotified(monitor.version);

    // When
    monitor.recordTransfer({ bytesPerSecond: 10 });
    monitor.recordTransfer({ bytesPerSecond: 10 });
    monitor.recordTransfer({ bytesPerSecond: 20 });

    // Then
    expect(versions).toEqual([1, 2]);
  });

  it.each<{ reports: string; send: () => void; sendChanged: () => void }>([
    {
      reports: 'peer counts',
      send() {
        monitor.recordPeerCount('relay', 4);
      },
      sendChanged() {
        monitor.recordPeerCount('relay', 5);
      },
    },
    {
      reports: 'transfer updates',
      send() {
        monitor.recordTransfer({ fetched: 1_000, total: 9_000 });
      },
      sendChanged() {
        monitor.recordTransfer({ fetched: 2_000, total: 9_000 });
      },
    },
    {
      reports: 'chain phases',
      send() {
        monitor.recordChainPhase('assethub', 'connecting');
      },
      sendChanged() {
        monitor.recordChainPhase('assethub', 'ready');
      },
    },
  ])(
    'As a user, I get $reports and see the panel repaint when one changes and stay quiet when it repeats',
    ({ send, sendChanged }) => {
      // Given
      let woken = 0;
      onTestFinished(
        monitor.version.listen(() => {
          woken += 1;
        }),
      );

      // When
      send();
      send();
      sendChanged();

      // Then
      expect(woken).toBe(2);
    },
  );
});

describe('The network monitor judges how each chain is used', () => {
  it('As a user whose app dropped its block follow but kept the chain, I wait and see its clock stopped and not overdue, then live again on a new follow', async () => {
    // Given
    use(getRelayGenesis());
    monitor.recordBestBlock(getRelayGenesis(), 100);
    await timers.advance(6000);
    monitor.recordBestBlock(getRelayGenesis(), 101);

    // When
    use(getRelayGenesis(), { following: false });
    await timers.advance(120_000);
    const unfollowed = getChainByKey('relay');
    use(getRelayGenesis());
    monitor.recordBestBlock(getRelayGenesis(), 140);

    // Then
    expect(unfollowed).toMatchObject({ state: 'live', alarm: false, sinceLast: null, latest: 101 });
    expect(unfollowed.bars.map(bar => bar.number)).toEqual([101]);
    expect(getChainByKey('relay')).toMatchObject({ state: 'live', latest: 140 });
    expect(getChainByKey('relay').bars.map(bar => bar.number)).toEqual([101]);
  });

  it('As a user, I follow a chain and see it pending until its first block, then live', () => {
    // When
    use(getRelayGenesis());
    const followed = getChainByKey('relay');
    monitor.recordBestBlock(getRelayGenesis(), 100);

    // Then
    expect(followed).toMatchObject({ state: 'pending', alarm: false });
    expect(getChainByKey('relay')).toMatchObject({ state: 'live', alarm: false });
  });

  it('As a user on trusted providers, I hold a chain without a follow and see it judged by its connection', () => {
    // When
    use(getRelayGenesis(), { following: false, status: 'connecting' });
    const connecting = getChainByKey('relay');
    use(getRelayGenesis(), { following: false, status: 'connected' });
    const connected = getChainByKey('relay');
    use(getRelayGenesis(), { following: false, status: 'connecting' });

    // Then
    expect(connecting).toMatchObject({ state: 'pending', alarm: false });
    expect(connected).toMatchObject({ state: 'live', alarm: false });
    expect(getChainByKey('relay')).toMatchObject({ state: 'live', alarm: true });
  });

  it('As a user, I release a chain and hold it again and see its connection start afresh', () => {
    // Given
    use(getRelayGenesis(), { following: false, status: 'connected' });
    release(getRelayGenesis());

    // When
    use(getRelayGenesis(), { following: false, status: 'connecting' });

    // Then
    expect(getChainByKey('relay')).toMatchObject({ state: 'pending', alarm: false });
  });

  it('As a user on trusted providers, I hold again a chain that reconnected while nothing held it and see it start afresh', () => {
    // Given a chain held while connecting, released, then reported connected while released
    use(getRelayGenesis(), { following: false, status: 'connecting' });
    release(getRelayGenesis());
    release(getRelayGenesis());

    // When
    use(getRelayGenesis(), { following: false, status: 'connecting' });

    // Then
    expect(getChainByKey('relay')).toMatchObject({ state: 'pending', alarm: false });
  });

  it('As a user loading a product, I watch the frame sync an unused chain and see it pending, then unused once ready', () => {
    // When
    monitor.recordChainPhase('relay', 'syncing');
    const syncing = getChainByKey('relay');
    monitor.recordChainPhase('relay', 'ready');

    // Then
    expect(syncing).toMatchObject({ state: 'pending', alarm: false });
    expect(getChainByKey('relay')).toMatchObject({ state: 'unused', alarm: false });
  });

  it('As a user, I see a frame chain drop from ready back to connecting and the alarm raised, used or not', () => {
    // Given
    monitor.recordChainPhase('relay', 'ready');

    // When
    monitor.recordChainPhase('relay', 'connecting');

    // Then
    expect(getChainByKey('relay')).toMatchObject({ state: 'live', alarm: true });
  });

  it('As a user, I see the frame call a chain in use stalled and the alarm raised', () => {
    // Given
    use(getRelayGenesis());
    monitor.recordBestBlock(getRelayGenesis(), 100);

    // When
    monitor.recordChainPhase('relay', 'stalled');

    // Then
    expect(getChainByKey('relay')).toMatchObject({ state: 'live', alarm: true });
  });

  it('As a user, I see an extra chain that was connected reconnect and the alarm raised', () => {
    // Given
    use(EXTRA, { following: false, status: 'connected' });

    // When
    use(EXTRA, { following: false, status: 'connecting' });

    // Then
    expect(getChainByKey(EXTRA)).toMatchObject({ state: 'live', alarm: true });
  });
});

describe('The network monitor after a return', () => {
  it('As a user back on my page, I see my chain as Connecting until its next block, not as overdue', async () => {
    // Given
    use(getRelayGenesis());
    monitor.recordBestBlock(getRelayGenesis(), 100);
    await timers.advance(120_000);

    // When
    monitor.recordReturn();
    const back = describeLiveNetwork(monitor.getChainClocks());
    monitor.recordBestBlock(getRelayGenesis(), 101);

    // Then
    expect(back).toEqual({ text: 'Connecting', tone: 'idle' });
    expect(describeLiveNetwork(monitor.getChainClocks()).text).toBe('Your connection is good');
  });

  it('As a user back on my page, I see a light client syncing again as Connecting, not as Waiting', () => {
    // Given
    monitor.recordChainPhase('relay', 'ready');

    // When
    monitor.recordReturn();
    monitor.recordChainPhase('relay', 'connecting');

    // Then
    expect(monitor.getChainClocks().some(chain => chain.alarm)).toBe(false);
  });

  it('As a user back on my page whose chain drops after its first block, I see it as Waiting again', () => {
    // Given
    use(getRelayGenesis());
    monitor.recordChainPhase('relay', 'ready');
    monitor.recordReturn();

    // When
    monitor.recordBestBlock(getRelayGenesis(), 100);
    monitor.recordChainPhase('relay', 'connecting');

    // Then
    expect(getChainByKey('relay').alarm).toBe(true);
  });

  it('As a user whose light client drops back with no return, I still see it as Waiting', () => {
    // Given
    monitor.recordChainPhase('relay', 'ready');

    // When
    monitor.recordChainPhase('relay', 'connecting');

    // Then
    expect(getChainByKey('relay').alarm).toBe(true);
  });

  it('As a user back on my page, I see a host pool that paused and reconnects as Connecting', () => {
    // Given
    use(EXTRA, { following: false, status: 'connected' });
    use(EXTRA, { following: false, status: 'disconnected' });

    // When
    monitor.recordReturn();
    use(EXTRA, { following: false, status: 'connecting' });

    // Then
    expect(getChainByKey(EXTRA)).toMatchObject({ state: 'pending', alarm: false });
  });

  it('As a user back on my page whose connected pool chain drops later, I see it as Waiting', () => {
    // Given
    use(EXTRA, { following: false, status: 'connected' });

    // When
    monitor.recordReturn();
    use(EXTRA, { following: false, status: 'connecting' });

    // Then
    expect(getChainByKey(EXTRA).alarm).toBe(true);
  });
});

/** A consumer holds the chain, connected and following, unless the test says otherwise. */
function use(genesis: string, overrides: Partial<ChainActivity> = {}): void {
  monitor.recordChainActivity(buildChainActivity({ genesisHash: genesis, ...overrides }));
}

function release(genesis: string): void {
  monitor.recordChainActivity(buildChainActivity({ genesisHash: genesis, held: false }));
}

function getChainByKey(key: string): ChainStatus {
  return must(
    monitor.getNetworkStatus().find(chain => chain.key === key),
    key,
  );
}
