import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyGap,
  endNetworkWatch,
  getNetworkStatus,
  resetNetworkMonitor,
  setBlockSource,
  startNetworkWatch,
  stopNetworkWatch,
  getTransfer,
  recordChainPhase,
  recordPeerCount,
  recordTransfer,
  subscribeNetwork,
  type BlockSource,
} from "@dotli/ui/network-monitor";
import { getActiveChainRoles } from "@dotli/config/network";

// Mirror of IDLE_GRACE_MS and MAX_BARS in network-monitor.ts.
const GRACE_MS = 60_000;
// Mirror of MAX_BARS in network-monitor.ts. A memory ceiling only: the
// panel decides what a visitor sees by measuring its own strip.
const MAX_BARS = 120;

/** A source the test drives by hand, one emitter per chain. */
function fakeSource(unreachable: string[] = []): {
  source: BlockSource;
  emit: (genesis: string, blockNumber: number) => void;
  liveCount: () => number;
} {
  const emitters = new Map<string, (n: number) => void>();
  let live = 0;
  return {
    source: {
      isReachable: (genesis) => !unreachable.includes(genesis),
      subscribe: (genesis, onBlock) => {
        emitters.set(genesis, onBlock);
        live += 1;
        return () => {
          emitters.delete(genesis);
          live -= 1;
        };
      },
    },
    emit: (genesis, blockNumber) => {
      emitters.get(genesis)?.(blockNumber);
    },
    liveCount: () => live,
  };
}

describe("Block arrival colouring works", () => {
  it("As a user, a block inside the expected time reads healthy", () => {
    expect(classifyGap(6000, 6000)).toBe("onTime");
    expect(classifyGap(9000, 6000)).toBe("onTime");
  });

  it("As a user, a block that is somewhat overdue reads as a warning", () => {
    expect(classifyGap(9001, 6000)).toBe("late");
    expect(classifyGap(18_000, 6000)).toBe("late");
  });

  it("As a user, a badly overdue block reads as a problem", () => {
    expect(classifyGap(18_001, 6000)).toBe("veryLate");
  });

  it("As a user on a 2s chain, the same gap is judged more harshly than on a 6s chain", () => {
    // Given
    const gap = 6000;

    // Then
    expect(classifyGap(gap, 6000)).toBe("onTime");
    expect(classifyGap(gap, 2000)).toBe("late");
    expect(classifyGap(gap + 1, 2000)).toBe("veryLate");
  });
});

describe("The network monitor tracks blocks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkMonitor();
  });

  afterEach(() => {
    resetNetworkMonitor();
    vi.useRealTimers();
  });

  it("As a user opening the panel, every chain of my network is listed", () => {
    // Given
    const { source } = fakeSource();
    setBlockSource(source);

    // When
    startNetworkWatch();

    // Then
    const labels = getNetworkStatus().map((c) => c.label);
    expect(labels).toEqual(["Relay", "Hub", "Storage", "Identity"]);
  });

  it("As a user watching a chain, the first block anchors and later ones get bars", () => {
    // Given
    const { source, emit } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    const relay = getNetworkStatus()[0];
    const genesis = relayGenesis();

    // When
    emit(genesis, 100);

    // Then
    expect(getNetworkStatus()[0].bars.length).toBe(0);
    expect(getNetworkStatus()[0].latest).toBe(100);

    // When
    vi.advanceTimersByTime(relay.blockTimeMs);
    emit(genesis, 101);

    // Then
    expect(getNetworkStatus()[0].bars).toEqual([
      { number: 101, health: "onTime", gapMs: relay.blockTimeMs },
    ]);
  });

  it("As a user on a degraded chain, the bar for a slow block is not green", () => {
    // Given
    const { source, emit } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    const genesis = relayGenesis();
    emit(genesis, 1);

    // When
    vi.advanceTimersByTime(60_000);
    emit(genesis, 2);

    // Then
    expect(getNetworkStatus()[0].bars[0].health).toBe("veryLate");
  });

  it("As a user with the panel open all day, memory stays bounded", () => {
    // Given
    const { source, emit } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    const genesis = relayGenesis();

    // When
    for (let i = 0; i < MAX_BARS + 15; i += 1) {
      vi.advanceTimersByTime(6000);
      emit(genesis, i);
    }

    // Then
    expect(getNetworkStatus()[0].bars.length).toBe(MAX_BARS);
  });

  it("As a user who kept the panel open, more history is retained than a strip can show", () => {
    // Given
    const { source, emit } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    const genesis = relayGenesis();

    // When
    for (let i = 0; i < 60; i += 1) {
      vi.advanceTimersByTime(6000);
      emit(genesis, i);
    }

    // Then
    expect(getNetworkStatus()[0].bars.length).toBeGreaterThan(36);
  });

  it("As a user on a chain that republishes its head, one block makes one bar", () => {
    // Given
    const { source, emit } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    const genesis = relayGenesis();

    // When
    vi.advanceTimersByTime(6000);
    emit(genesis, 100);
    vi.advanceTimersByTime(6000);
    emit(genesis, 101);
    emit(genesis, 101);
    emit(genesis, 101);
    vi.advanceTimersByTime(6000);
    emit(genesis, 102);

    // Then
    const bars = getNetworkStatus()[0].bars;
    expect(bars.map((b) => b.number)).toEqual([101, 102]);
  });

  it("As a user whose chain reorgs to an earlier block, the strip does not go backwards", () => {
    // Given
    const { source, emit } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    const genesis = relayGenesis();

    // When
    vi.advanceTimersByTime(6000);
    emit(genesis, 200);
    vi.advanceTimersByTime(6000);
    emit(genesis, 201);
    vi.advanceTimersByTime(6000);
    emit(genesis, 199);

    // Then
    expect(getNetworkStatus()[0].bars.map((b) => b.number)).toEqual([201]);
  });

  it("As a user reopening the panel quickly, watching never stopped", () => {
    // Given
    const { source, liveCount } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    const before = liveCount();

    // When
    stopNetworkWatch();
    vi.advanceTimersByTime(GRACE_MS - 1000);
    startNetworkWatch();
    vi.advanceTimersByTime(GRACE_MS * 2);

    // Then
    expect(liveCount()).toBe(before);
  });

  it("As a user who closed the panel and walked away, nothing is left watching", () => {
    // Given
    const { source, liveCount } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    expect(liveCount()).toBeGreaterThan(0);

    // When
    stopNetworkWatch();
    vi.advanceTimersByTime(GRACE_MS + 1000);

    // Then
    expect(liveCount()).toBe(0);
  });

  it("As a user on a network missing an endpoint, that chain is marked unreachable", () => {
    // Given
    const { source } = fakeSource([relayGenesis()]);
    setBlockSource(source);

    // When
    startNetworkWatch();

    // Then
    expect(getNetworkStatus()[0].reachable).toBe(false);
  });

  it("As a user with the panel open, a new block shows up the moment it lands", () => {
    // Given
    const { source, emit } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    let calls = 0;
    const off = subscribeNetwork(() => {
      calls += 1;
    });

    // When
    emit(relayGenesis(), 7);

    // Then
    expect(calls).toBe(1);
    off();
    emit(relayGenesis(), 8);
    expect(calls).toBe(1);
  });

  it("As a user hovering a bar, the gap that produced it is recorded", () => {
    // Given
    const { source, emit } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    const genesis = relayGenesis();
    emit(genesis, 1);

    // When
    vi.advanceTimersByTime(15_000);
    emit(genesis, 2);

    // Then
    expect(getNetworkStatus()[0].bars[0].gapMs).toBe(15_000);
  });

  it("As a user closing the page, nothing keeps watching the chains", () => {
    // Given
    const { source, liveCount } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();

    // When
    endNetworkWatch();

    // Then
    expect(liveCount()).toBe(0);
  });
});

describe("The network monitor tracks peers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkMonitor();
  });

  afterEach(() => {
    resetNetworkMonitor();
    vi.useRealTimers();
  });

  it("As a user opening the panel before any sample, no chain claims a peer count", () => {
    // Given
    const { source } = fakeSource();
    setBlockSource(source);

    // When
    startNetworkWatch();

    // Then
    expect(getNetworkStatus().map((c) => c.peers)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("As a user watching the panel, each chain reports the peers it actually holds", () => {
    // Given
    const { source } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();

    // When
    recordPeerCount("relay", 7);
    recordPeerCount("assethub", 3);

    // Then
    const byRole = new Map(getNetworkStatus().map((c) => [c.role, c.peers]));
    expect(byRole.get("relay")).toBe(7);
    expect(byRole.get("assethub")).toBe(3);
    expect(byRole.get("people")).toBeNull();
  });

  it("As a user, the panel repaints when a peer count changes and stays quiet when it repeats", () => {
    // Given
    const { source } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    let woken = 0;
    subscribeNetwork(() => {
      woken += 1;
    });

    // When
    recordPeerCount("relay", 4);
    recordPeerCount("relay", 4);
    recordPeerCount("relay", 5);

    // Then
    expect(woken).toBe(2);
  });

  it("As a user who closed the panel and reopened it, the peer count survived", () => {
    // Given
    const { source } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    recordPeerCount("relay", 6);

    // When
    stopNetworkWatch();
    vi.advanceTimersByTime(GRACE_MS + 1_000);
    startNetworkWatch();

    // Then
    const relay = getNetworkStatus().find((c) => c.role === "relay");
    expect(relay?.peers).toBe(6);
  });
});

describe("The network monitor tracks the connection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkMonitor();
  });

  afterEach(() => {
    resetNetworkMonitor();
    vi.useRealTimers();
  });

  it("As a user opening the panel before anything moves, nothing is claimed about the connection", () => {
    // Given
    expect(getTransfer()).toEqual({
      bytesPerSecond: null,
      fetched: null,
      total: null,
    });
  });

  it("As a user watching a download, the speed and the progress each survive an update to the other", () => {
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

  it("As a user, the panel repaints when the transfer changes and stays quiet when it repeats", () => {
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

  it("As a user on a load that declared no size, no progress is invented", () => {
    // Given
    recordTransfer({ fetched: 900_000, total: null });

    // Then
    expect(getTransfer().total).toBeNull();
  });
});

describe("The network monitor tracks the phase of each chain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkMonitor();
  });

  afterEach(() => {
    resetNetworkMonitor();
    vi.useRealTimers();
  });

  it("As a user opening the panel before the light client speaks, no phase is claimed", () => {
    // Given
    const { source } = fakeSource();
    setBlockSource(source);

    // When
    startNetworkWatch();

    // Then
    expect(getNetworkStatus().map((c) => c.phase)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("As a user watching a chain come up, the panel follows it through to ready", () => {
    // Given
    const { source } = fakeSource();
    setBlockSource(source);
    startNetworkWatch();
    const relay = () => getNetworkStatus().find((c) => c.role === "relay");

    // When
    recordChainPhase("relay", "connecting");
    expect(relay()?.phase).toBe("connecting");
    recordChainPhase("relay", "syncing");
    expect(relay()?.phase).toBe("syncing");
    recordChainPhase("relay", "ready");
    expect(relay()?.phase).toBe("ready");
  });

  it("As a user, the panel repaints when a chain phase changes and stays quiet when it repeats", () => {
    // Given
    let woken = 0;
    subscribeNetwork(() => {
      woken += 1;
    });

    // When
    recordChainPhase("assethub", "connecting");
    recordChainPhase("assethub", "connecting");
    recordChainPhase("assethub", "ready");

    // Then
    expect(woken).toBe(2);
  });
});

/** The relay genesis of the active network, which the fake source keys on. */
function relayGenesis(): string {
  return getActiveChainRoles()[0].genesis;
}
