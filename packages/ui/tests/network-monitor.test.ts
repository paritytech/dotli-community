import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveChainRoles } from '@dotli/config';
import type { ChainActivity } from '@dotli/protocol';
import type * as ProtocolModule from '@dotli/protocol';
import {
  classifyGap,
  getNetworkStatus,
  resetNetworkMonitor,
  getTransfer,
  recordBestBlock,
  recordChainActivity,
  recordChainPhase,
  recordPeerCount,
  recordTransfer,
  subscribeNetwork,
  type ChainStatus,
} from '../src/network-monitor.js';
import { nth } from './helpers/nth.js';
import { must } from './support.js';

const reach = vi.hoisted(() => ({ unreachable: new Set<string>() }));
vi.mock('@dotli/protocol', async importOriginal => ({
  ...(await importOriginal<typeof ProtocolModule>()),
  isRemoteChainConnectable: (genesis: string) => !reach.unreachable.has(genesis.toLowerCase()),
}));

// Mirror of MAX_BARS in network-monitor.ts. A memory ceiling only, as the panel measures what a visitor sees.
const MAX_BARS = 120;
const EXTRA = `0x${'ab'.repeat(32)}`;

const relayGenesis = (): string => nth(getActiveChainRoles(), 0).genesis;

/** A consumer holds the chain, connected and following, unless the test says otherwise. */
function use(genesis: string, overrides: Partial<ChainActivity> = {}): void {
  recordChainActivity({ genesisHash: genesis, consumers: 1, status: 'connected', following: true, ...overrides });
}

function release(genesis: string): void {
  recordChainActivity({ genesisHash: genesis, consumers: 0, status: 'connected', following: false });
}

const chainByKey = (key: string): ChainStatus =>
  must(
    getNetworkStatus().find(chain => chain.key === key),
    key,
  );

describe('Block arrival colouring works', () => {
  it('As a user, a block inside the expected time reads healthy', () => {
    expect(classifyGap(6000, 6000)).toBe('onTime');
    expect(classifyGap(9000, 6000)).toBe('onTime');
  });

  it('As a user, a block that is somewhat overdue reads as a warning', () => {
    expect(classifyGap(9001, 6000)).toBe('late');
    expect(classifyGap(18_000, 6000)).toBe('late');
  });

  it('As a user, a badly overdue block reads as a problem', () => {
    expect(classifyGap(18_001, 6000)).toBe('veryLate');
  });

  it('As a user on a 2s chain, the same gap is judged more harshly than on a 6s chain', () => {
    // Given
    const gap = 6000;

    // Then
    expect(classifyGap(gap, 6000)).toBe('onTime');
    expect(classifyGap(gap, 2000)).toBe('late');
    expect(classifyGap(gap + 1, 2000)).toBe('veryLate');
  });
});

describe('The network monitor tracks blocks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkMonitor();
    reach.unreachable.clear();
  });

  afterEach(() => {
    resetNetworkMonitor();
    reach.unreachable.clear();
    vi.useRealTimers();
  });

  it('As a user opening the panel, every known chain of my network is listed and unused', () => {
    // Then
    expect(getNetworkStatus().map(chain => [chain.key, chain.label, chain.state])).toEqual([
      ['relay', 'Relay', 'unused'],
      ['assethub', 'Hub', 'unused'],
      ['bulletin', 'Storage', 'unused'],
      ['people', 'Identity', 'unused'],
    ]);
  });

  it('As a user, a chain nobody uses records no blocks', () => {
    // When
    recordBestBlock(relayGenesis(), 100);

    // Then
    expect(chainByKey('relay').latest).toBeNull();
  });

  it('As a user, a chain the pool names in lowercase lands on its known row', () => {
    // When
    use(relayGenesis().toUpperCase().replace(/^0X/, '0x'));
    use(relayGenesis().toLowerCase());

    // Then
    expect(getNetworkStatus()).toHaveLength(4);
    expect(chainByKey('relay').state).not.toBe('unused');
  });

  it('As a user, a known chain going unused loses its history', () => {
    // Given
    use(relayGenesis());
    recordBestBlock(relayGenesis(), 100);
    vi.advanceTimersByTime(6000);
    recordBestBlock(relayGenesis(), 101);

    // When
    release(relayGenesis());

    // Then
    expect(chainByKey('relay')).toMatchObject({ bars: [], latest: null, state: 'unused' });
  });

  it('As a user of a product on another chain, it is listed while in use and gone after', () => {
    // When
    use(EXTRA);

    // Then
    expect(chainByKey(EXTRA)).toMatchObject({ role: null, label: '0xabab…abab', blockTimeMs: 6000, reachable: true });

    // When
    release(EXTRA);

    // Then
    expect(getNetworkStatus().some(chain => chain.key === EXTRA)).toBe(false);
  });

  it('As a user, a chain released before it was ever held is never listed', () => {
    // When
    release(EXTRA);

    // Then
    expect(getNetworkStatus()).toHaveLength(4);
  });

  it('As a user watching a chain, the first block anchors and later ones get bars', () => {
    // Given
    use(relayGenesis());
    const relay = nth(getNetworkStatus(), 0);
    const genesis = relayGenesis();

    // When
    recordBestBlock(genesis, 100);

    // Then
    expect(getNetworkStatus()[0]?.bars.length).toBe(0);
    expect(getNetworkStatus()[0]?.latest).toBe(100);

    // When
    vi.advanceTimersByTime(relay.blockTimeMs);
    recordBestBlock(genesis, 101);

    // Then
    expect(getNetworkStatus()[0]?.bars).toEqual([{ number: 101, health: 'onTime', gapMs: relay.blockTimeMs }]);
  });

  it('As a reader holding a snapshot, later blocks do not change its bars', () => {
    // Given
    use(relayGenesis());
    const relay = nth(getNetworkStatus(), 0);
    const genesis = relayGenesis();
    recordBestBlock(genesis, 100);
    vi.advanceTimersByTime(relay.blockTimeMs);
    recordBestBlock(genesis, 101);
    const held = nth(getNetworkStatus(), 0).bars;

    // When
    vi.advanceTimersByTime(relay.blockTimeMs);
    recordBestBlock(genesis, 102);

    // Then
    expect(held.map(b => b.number)).toEqual([101]);
    expect(Object.isFrozen(held)).toBe(true);
    expect(getNetworkStatus()[0]?.bars.map(b => b.number)).toEqual([101, 102]);
  });

  it('As a user on a degraded chain, the bar for a slow block is not green', () => {
    // Given
    use(relayGenesis());
    const genesis = relayGenesis();
    recordBestBlock(genesis, 1);

    // When
    vi.advanceTimersByTime(60_000);
    recordBestBlock(genesis, 2);

    // Then
    expect(getNetworkStatus()[0]?.bars[0]?.health).toBe('veryLate');
  });

  it('As a user with the panel open all day, memory stays bounded', () => {
    // Given
    use(relayGenesis());
    const genesis = relayGenesis();

    // When
    for (let i = 0; i < MAX_BARS + 15; i += 1) {
      vi.advanceTimersByTime(6000);
      recordBestBlock(genesis, i);
    }

    // Then
    expect(getNetworkStatus()[0]?.bars.length).toBe(MAX_BARS);
  });

  it('As a user who kept the panel open, more history is retained than a strip can show', () => {
    // Given
    use(relayGenesis());
    const genesis = relayGenesis();

    // When
    for (let i = 0; i < 60; i += 1) {
      vi.advanceTimersByTime(6000);
      recordBestBlock(genesis, i);
    }

    // Then
    expect(getNetworkStatus()[0]?.bars.length).toBeGreaterThan(36);
  });

  it('As a user on a chain that republishes its head, one block makes one bar', () => {
    // Given
    use(relayGenesis());
    const genesis = relayGenesis();

    // When
    vi.advanceTimersByTime(6000);
    recordBestBlock(genesis, 100);
    vi.advanceTimersByTime(6000);
    recordBestBlock(genesis, 101);
    recordBestBlock(genesis, 101);
    recordBestBlock(genesis, 101);
    vi.advanceTimersByTime(6000);
    recordBestBlock(genesis, 102);

    // Then
    const bars = nth(getNetworkStatus(), 0).bars;
    expect(bars.map(b => b.number)).toEqual([101, 102]);
  });

  it('As a user whose chain reorgs to an earlier block, the strip does not go backwards', () => {
    // Given
    use(relayGenesis());
    const genesis = relayGenesis();

    // When
    vi.advanceTimersByTime(6000);
    recordBestBlock(genesis, 200);
    vi.advanceTimersByTime(6000);
    recordBestBlock(genesis, 201);
    vi.advanceTimersByTime(6000);
    recordBestBlock(genesis, 199);

    // Then
    expect(getNetworkStatus()[0]?.bars.map(b => b.number)).toEqual([201]);
  });

  it('As a user on a network missing an endpoint, that chain is marked unreachable and never in use', () => {
    // Given
    reach.unreachable.add(relayGenesis().toLowerCase());

    // When
    use(relayGenesis());

    // Then
    expect(chainByKey('relay')).toMatchObject({ reachable: false, state: 'unused' });
  });

  it('As a user with the panel open, a new block shows up the moment it lands', () => {
    // Given
    use(relayGenesis());
    let calls = 0;
    const off = subscribeNetwork(() => {
      calls += 1;
    });

    // When
    recordBestBlock(relayGenesis(), 7);

    // Then
    expect(calls).toBe(1);
    off();
    recordBestBlock(relayGenesis(), 8);
    expect(calls).toBe(1);
  });

  it('As a user hovering a bar, the gap that produced it is recorded', () => {
    // Given
    use(relayGenesis());
    const genesis = relayGenesis();
    recordBestBlock(genesis, 1);

    // When
    vi.advanceTimersByTime(15_000);
    recordBestBlock(genesis, 2);

    // Then
    expect(getNetworkStatus()[0]?.bars[0]?.gapMs).toBe(15_000);
  });
});

describe('The network monitor tracks peers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkMonitor();
    reach.unreachable.clear();
  });

  afterEach(() => {
    resetNetworkMonitor();
    reach.unreachable.clear();
    vi.useRealTimers();
  });

  it('As a user opening the panel before any sample, no chain claims a peer count', () => {
    // Then
    expect(getNetworkStatus().map(c => c.peers)).toEqual([null, null, null, null]);
  });

  it('As a user watching the panel, each chain reports the peers it actually holds', () => {
    // When
    recordPeerCount('relay', 7);
    recordPeerCount('assethub', 3);

    // Then
    const byRole = new Map(getNetworkStatus().map(c => [c.role, c.peers]));
    expect(byRole.get('relay')).toBe(7);
    expect(byRole.get('assethub')).toBe(3);
    expect(byRole.get('people')).toBeNull();
  });

  it('As a user, the panel repaints when a peer count changes and stays quiet when it repeats', () => {
    // Given
    let woken = 0;
    subscribeNetwork(() => {
      woken += 1;
    });

    // When
    recordPeerCount('relay', 4);
    recordPeerCount('relay', 4);
    recordPeerCount('relay', 5);

    // Then
    expect(woken).toBe(2);
  });
});

describe('The network monitor tracks the connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkMonitor();
    reach.unreachable.clear();
  });

  afterEach(() => {
    resetNetworkMonitor();
    reach.unreachable.clear();
    vi.useRealTimers();
  });

  it('As a user opening the panel before anything moves, nothing is claimed about the connection', () => {
    // Given
    expect(getTransfer()).toEqual({
      bytesPerSecond: null,
      fetched: null,
      total: null,
    });
  });

  it('As a user watching a download, the speed and the progress each survive an update to the other', () => {
    // Given
    recordTransfer({ bytesPerSecond: 962_560 });
    recordTransfer({ fetched: 6_400_000, total: 14_600_000 });

    // When
    recordTransfer({ bytesPerSecond: 1_010_000 });

    // Then
    expect(getTransfer()).toEqual({
      bytesPerSecond: 1_010_000,
      fetched: 6_400_000,
      total: 14_600_000,
    });
  });

  it('As a user, the panel repaints when the transfer changes and stays quiet when it repeats', () => {
    // Given
    let woken = 0;
    subscribeNetwork(() => {
      woken += 1;
    });

    // When
    recordTransfer({ fetched: 1_000, total: 9_000 });
    recordTransfer({ fetched: 1_000, total: 9_000 });
    recordTransfer({ fetched: 2_000, total: 9_000 });

    // Then
    expect(woken).toBe(2);
  });

  it('As a user on a load that declared no size, no progress is invented', () => {
    // Given
    recordTransfer({ fetched: 900_000, total: null });

    // Then
    expect(getTransfer().total).toBeNull();
  });
});

describe('The network monitor tracks the phase of each chain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkMonitor();
    reach.unreachable.clear();
  });

  afterEach(() => {
    resetNetworkMonitor();
    reach.unreachable.clear();
    vi.useRealTimers();
  });

  it('As a user opening the panel before the light client speaks, no phase is claimed', () => {
    // Then
    expect(getNetworkStatus().map(c => c.phase)).toEqual([null, null, null, null]);
  });

  it('As a user watching a chain come up, the panel follows it through to ready', () => {
    // Given
    const relay = (): ChainStatus | undefined => getNetworkStatus().find(c => c.role === 'relay');

    // When
    recordChainPhase('relay', 'connecting');
    expect(relay()?.phase).toBe('connecting');
    recordChainPhase('relay', 'syncing');
    expect(relay()?.phase).toBe('syncing');
    recordChainPhase('relay', 'ready');
    expect(relay()?.phase).toBe('ready');
  });

  it('As a user, the panel repaints when a chain phase changes and stays quiet when it repeats', () => {
    // Given
    let woken = 0;
    subscribeNetwork(() => {
      woken += 1;
    });

    // When
    recordChainPhase('assethub', 'connecting');
    recordChainPhase('assethub', 'connecting');
    recordChainPhase('assethub', 'ready');

    // Then
    expect(woken).toBe(2);
  });
});

describe('The network monitor judges how each chain is used', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkMonitor();
    reach.unreachable.clear();
  });

  afterEach(() => {
    resetNetworkMonitor();
    vi.useRealTimers();
  });

  it('As a user, a followed chain is pending until its first block, then live', () => {
    // When
    use(relayGenesis());

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'pending', alarm: false });

    // When
    recordBestBlock(relayGenesis(), 100);

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'live', alarm: false });
  });

  it('As a user on trusted providers, a chain held without a follow is judged by its connection', () => {
    // When
    use(relayGenesis(), { following: false, status: 'connecting' });

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'pending', alarm: false });

    // When
    use(relayGenesis(), { following: false, status: 'connected' });

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'live', alarm: false });

    // When
    use(relayGenesis(), { following: false, status: 'connecting' });

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'live', alarm: true });
  });

  it('As a user, a chain released and held again starts its connection afresh', () => {
    // Given
    use(relayGenesis(), { following: false, status: 'connected' });
    release(relayGenesis());

    // When
    use(relayGenesis(), { following: false, status: 'connecting' });

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'pending', alarm: false });
  });

  it('As a user on trusted providers, a chain that reconnected while nothing held it starts afresh when held again', () => {
    // Given
    use(relayGenesis(), { following: false, status: 'connecting' });
    release(relayGenesis());
    recordChainActivity({ genesisHash: relayGenesis(), consumers: 0, status: 'connected', following: false });

    // When
    use(relayGenesis(), { following: false, status: 'connecting' });

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'pending', alarm: false });
  });

  it('As a user loading a product, the frame syncing an unused chain counts as pending', () => {
    // When
    recordChainPhase('relay', 'syncing');

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'pending', alarm: false });

    // When
    recordChainPhase('relay', 'ready');

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'unused', alarm: false });
  });

  it('As a user, a frame chain that was ready and drops back to connecting raises the alarm, used or not', () => {
    // Given
    recordChainPhase('relay', 'ready');

    // When
    recordChainPhase('relay', 'connecting');

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'live', alarm: true });
  });

  it('As a user, a chain in use that the frame calls stalled raises the alarm', () => {
    // Given
    use(relayGenesis());
    recordBestBlock(relayGenesis(), 100);

    // When
    recordChainPhase('relay', 'stalled');

    // Then
    expect(chainByKey('relay')).toMatchObject({ state: 'live', alarm: true });
  });

  it('As a user, an extra chain that was connected and reconnects raises the alarm', () => {
    // Given
    use(EXTRA, { following: false, status: 'connected' });

    // When
    use(EXTRA, { following: false, status: 'connecting' });

    // Then
    expect(chainByKey(EXTRA)).toMatchObject({ state: 'live', alarm: true });
  });
});
