import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyGap,
  endNetworkWatch,
  getNetworkStatus,
  resetNetworkMonitor,
  setBlockSource,
  startNetworkWatch,
  stopNetworkWatch,
  subscribeNetwork,
  type BlockSource,
} from "@dotli/ui/network-monitor";
import { getActiveChainRoles } from "@dotli/config/network";

// Mirror of IDLE_GRACE_MS and MAX_BARS in network-monitor.ts.
const GRACE_MS = 60_000;
const MAX_BARS = 40;

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
    // Given the measured rates, Storage at 6s and General at 2s. Six seconds is
    // exactly on time for one and exactly the far edge of late for the other,
    // which is the whole reason Bulletin cannot share a threshold with AssetHub.
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
    expect(labels).toEqual(["Relay", "General", "Storage", "Identity"]);
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

    // Then the first block cannot be judged, so it makes no bar
    expect(getNetworkStatus()[0].bars.length).toBe(0);
    expect(getNetworkStatus()[0].latest).toBe(100);

    // When a second arrives on time
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

  it("As a user with the panel open a long time, history stays bounded", () => {
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

  it("As a renderer, I am told whenever a block lands", () => {
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

    // And after unsubscribing
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

    // When a block arrives well after the chain's own expectation
    vi.advanceTimersByTime(15_000);
    emit(genesis, 2);

    // Then
    expect(getNetworkStatus()[0].bars[0].gapMs).toBe(15_000);
  });

  it("As a page being torn down, every subscription is dropped at once", () => {
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

/** The active network's relay genesis, which the fake source keys on. */
function relayGenesis(): string {
  return getActiveChainRoles()[0].genesis;
}
