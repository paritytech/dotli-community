// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from "vitest";

// Queue-backed chain mocks. Tests push raw JSON-RPC responses and the chain
// tap's pump consumes them exactly as it does the real light client's.
const chainMocks = vi.hoisted(() => {
  interface MockChain {
    sendJsonRpc: ReturnType<typeof vi.fn>;
    nextJsonRpcResponse: () => Promise<string>;
    jsonRpcResponses: AsyncGenerator<string>;
    remove: ReturnType<typeof vi.fn>;
    push(raw: string): void;
  }
  const chains: MockChain[] = [];
  function makeChain(): MockChain {
    const queue: string[] = [];
    // The tap's pump awaits one response at a time, so at most one caller
    // is ever waiting.
    let waiting: ((s: string) => void) | null = null;
    const chain: MockChain = {
      sendJsonRpc: vi.fn(),
      nextJsonRpcResponse: () =>
        new Promise<string>((resolve) => {
          const next = queue.shift();
          if (next !== undefined) {
            resolve(next);
          } else {
            waiting = resolve;
          }
        }),
      jsonRpcResponses: (async function* () {})(),
      remove: vi.fn(),
      push(raw: string) {
        const waiter = waiting;
        if (waiter !== null) {
          waiting = null;
          waiter(raw);
        } else {
          queue.push(raw);
        }
      },
    };
    chains.push(chain);
    return chain;
  }
  return { chains, makeChain };
});

vi.mock("polkadot-api/smoldot", () => ({
  start: vi.fn(() => ({
    addChain: vi.fn(() => Promise.resolve(chainMocks.makeChain())),
  })),
}));

vi.mock("polkadot-api/smoldot/from-worker", () => ({
  startFromWorker: vi.fn(() => ({
    addChain: vi.fn(() => Promise.resolve(chainMocks.makeChain())),
  })),
}));

vi.mock("polkadot-api/smoldot/worker?worker", () => {
  return { default: class MockWorker {} };
});

vi.mock("polkadot-api/sm-provider", () => ({
  getSmProvider: vi.fn((chain: unknown) => {
    const provider = vi.fn();
    (provider as Record<string, unknown>).__chain = chain;
    return provider;
  }),
}));

vi.mock("@dotli/resolver/chain-specs", () => ({
  getPaseoChainSpec: vi.fn().mockResolvedValue('{"name":"paseo"}'),
  getAssetHubPaseoChainSpec: vi
    .fn()
    .mockResolvedValue('{"name":"asset-hub-paseo"}'),
}));

let getSmoldot: typeof import("@dotli/resolver/smoldot").getSmoldot;
let getRelayChain: typeof import("@dotli/resolver/smoldot").getRelayChain;
let onChainSync: typeof import("@dotli/resolver/smoldot").onChainSync;
let enableSyncReporting: typeof import("@dotli/resolver/smoldot").enableSyncReporting;

beforeEach(async () => {
  vi.clearAllMocks();
  chainMocks.chains.length = 0;
  vi.resetModules();
  const mod = await import("@dotli/resolver/smoldot");
  getSmoldot = mod.getSmoldot;
  getRelayChain = mod.getRelayChain;
  onChainSync = mod.onChainSync;
  enableSyncReporting = mod.enableSyncReporting;
});

/**
 * Let the tap's pump loop drain everything pushed so far.
 *
 * Each queued response costs the pump a few microtask turns, so this yields
 * generously rather than counting them. Raise it if a future pump grows
 * more await points and events start arriving after the assertion.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
}

/** Start the relay chain and hand back the mock feeding it. */
async function startRelay(): Promise<{
  tapped: Awaited<ReturnType<typeof getRelayChain>>;
  raw: (typeof chainMocks.chains)[number];
}> {
  const tapped = await getRelayChain();
  const raw = chainMocks.chains.at(-1);
  if (raw === undefined) {
    throw new Error("relay chain mock was not created");
  }
  return { tapped, raw };
}

const FOLLOW_REPLY = JSON.stringify({
  jsonrpc: "2.0",
  id: "__dotli_lifecycle_follow__:relay",
  result: "sub-1",
});

function milestone(
  subscription: string,
  kind: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "lifecycle_unstable_followEvent",
    params: { subscription, result: { kind, ...extra } },
  });
}

function peerReport(seq: number, peers: number, isSyncing = true): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: `__dotli_health__:relay:${String(seq)}`,
    result: { isSyncing, peers, shouldHavePeers: true },
  });
}

function peerRequests(chain: { sendJsonRpc: ReturnType<typeof vi.fn> }) {
  return chain.sendJsonRpc.mock.calls
    .map((call) => call[0] as string)
    .filter((raw) => raw.includes("system_health"));
}

describe("Light client sync reporting works", () => {
  it("As a user opening several apps in one tab, they share a single light client", () => {
    // Given / When
    const first = getSmoldot();
    const second = getSmoldot();

    // Then
    expect(first).toBe(second);
  });

  it("As a user opening several apps in one tab, they share a single relay chain connection", async () => {
    // Given / When
    const first = getRelayChain();
    const second = getRelayChain();

    // Then
    expect(first).toBe(second);
    expect(typeof (await first).sendJsonRpc).toBe("function");
  });

  it("As a user waiting for a domain, the shell learns when the first peer arrives and when the chain is ready", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const { raw } = await startRelay();
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));

    // When
    raw.push(FOLLOW_REPLY);
    raw.push(milestone("sub-1", "firstPeer"));
    raw.push(milestone("sub-1", "bootstrapComplete"));
    await flush();

    // Then
    expect(milestones).toEqual([
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user on a chain with real catching up to do, the shell learns how far along the warp is", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const { raw } = await startRelay();
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));

    // When
    raw.push(FOLLOW_REPLY);
    raw.push(milestone("sub-1", "connecting"));
    raw.push(milestone("sub-1", "warpSyncProgress", { at: 20, target: 100 }));
    raw.push(milestone("sub-1", "warpSyncProgress", { at: 75, target: 100 }));
    raw.push(milestone("sub-1", "warpSyncFinished", { finalized: 100 }));
    await flush();

    // Then
    expect(milestones).toEqual([
      { chain: "relay", kind: "connecting" },
      { chain: "relay", kind: "warpSyncProgress", at: 20, target: 100 },
      { chain: "relay", kind: "warpSyncProgress", at: 75, target: 100 },
      { chain: "relay", kind: "warpSyncFinished", finalized: 100 },
    ]);
  });

  it("As a user whose connection drops mid-sync, the shell learns why it stalled and when it recovered", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const { raw } = await startRelay();
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));

    // When
    raw.push(FOLLOW_REPLY);
    raw.push(milestone("sub-1", "stalled", { reason: "noPeers" }));
    raw.push(milestone("sub-1", "recovered", { previously: "noPeers" }));
    await flush();

    // Then
    expect(milestones).toEqual([
      { chain: "relay", kind: "stalled", reason: "noPeers" },
      { chain: "relay", kind: "recovered", reason: "noPeers" },
    ]);
  });

  it("As a user opening the loading screen late, I see the newest sync state rather than a replay of every step", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const { raw } = await startRelay();
    raw.push(FOLLOW_REPLY);
    raw.push(milestone("sub-1", "stalled", { reason: "noPeers" }));
    raw.push(milestone("sub-1", "stalled", { reason: "syncNoProgress" }));
    raw.push(milestone("sub-1", "firstPeer"));
    await flush();

    // When
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));

    // Then
    expect(milestones).toEqual([
      { chain: "relay", kind: "stalled", reason: "syncNoProgress" },
      { chain: "relay", kind: "firstPeer" },
    ]);
  });

  it("As a user whose sync recovered before I looked, I am not told it is still stalled", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const { raw } = await startRelay();
    raw.push(FOLLOW_REPLY);
    raw.push(milestone("sub-1", "stalled", { reason: "noPeers" }));
    raw.push(milestone("sub-1", "recovered", { previously: "noPeers" }));
    await flush();

    // When
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));

    // Then
    expect(milestones).toEqual([
      { chain: "relay", kind: "recovered", reason: "noPeers" },
    ]);
  });

  it("As a user waiting for a domain, I am told how many peers the light client found", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
    const { raw } = await startRelay();
    const counts: unknown[] = [];
    onChainSync((event) => counts.push(event));

    // When
    raw.push(peerReport(1, 3));
    await flush();

    // Then
    expect(peerRequests(raw)[0]).toContain('"id":"__dotli_health__:relay:1"');
    expect(counts).toEqual([
      { chain: "relay", kind: "peers", peers: 3, isSyncing: true },
    ]);
  });

  it("As a user with a steady connection, the peer count only changes when the number really changes", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
    const { raw } = await startRelay();
    const counts: unknown[] = [];
    onChainSync((event) => counts.push(event));

    // When
    raw.push(peerReport(1, 2));
    raw.push(peerReport(2, 2));
    raw.push(peerReport(3, 5));
    await flush();

    // Then
    expect(counts).toEqual([
      { chain: "relay", kind: "peers", peers: 2, isSyncing: true },
      { chain: "relay", kind: "peers", peers: 5, isSyncing: true },
    ]);
  });

  it("As a user opening the loading screen late, I still see the peer count already found", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
    const { raw } = await startRelay();
    raw.push(peerReport(1, 4));
    await flush();

    // When
    const counts: unknown[] = [];
    onChainSync((event) => counts.push(event));

    // Then
    expect(counts).toEqual([
      { chain: "relay", kind: "peers", peers: 4, isSyncing: true },
    ]);
  });

  it("As a user whose chain finished syncing, nothing keeps asking for peers", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const { raw } = await startRelay();
      raw.push(FOLLOW_REPLY);
      raw.push(peerReport(1, 3));

      // When
      raw.push(milestone("sub-1", "bootstrapComplete"));
      await flush();
      const asked = peerRequests(raw).length;
      await vi.advanceTimersByTimeAsync(30_000);

      // Then
      expect(peerRequests(raw).length).toBe(asked);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a user loading an app, the shell's own sync questions never reach the app's chain traffic", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const { tapped, raw } = await startRelay();
    const appResponse = JSON.stringify({
      jsonrpc: "2.0",
      id: "1-42",
      result: "0x00",
    });

    // When
    raw.push(FOLLOW_REPLY);
    raw.push(milestone("sub-1", "firstPeer"));
    raw.push(appResponse);
    await flush();

    // Then
    await expect(tapped.nextJsonRpcResponse()).resolves.toBe(appResponse);
  });
});

describe("Light client sync reporting fails", () => {
  it("As a user, a sync message meant for something else never moves my loading screen", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const { tapped, raw } = await startRelay();
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));
    const foreign = milestone("someone-elses-sub", "firstPeer");

    // When
    raw.push(FOLLOW_REPLY);
    raw.push(foreign);
    await flush();

    // Then
    expect(milestones).toEqual([]);
    await expect(tapped.nextJsonRpcResponse()).resolves.toBe(foreign);
  });

  it("As a user, sync milestones the shell has no wording for are ignored", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const { tapped, raw } = await startRelay();
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));
    const appResponse = JSON.stringify({ jsonrpc: "2.0", id: "1-1" });

    // When
    raw.push(FOLLOW_REPLY);
    // `modeDecision` is real and we deliberately have nothing to say about it.
    raw.push(milestone("sub-1", "modeDecision", { mode: "warpSync" }));
    raw.push(appResponse);
    await flush();

    // Then
    expect(milestones).toEqual([]);
    await expect(tapped.nextJsonRpcResponse()).resolves.toBe(appResponse);
  });

  it("As a user, a peer count that arrives malformed never reaches my loading screen", async () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
    const { raw } = await startRelay();
    const counts: unknown[] = [];
    onChainSync((event) => counts.push(event));

    // When
    raw.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "__dotli_health__:relay:1",
        result: { isSyncing: true, peers: "3" },
      }),
    );
    raw.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "__dotli_health__:relay:2",
        error: { code: -32000, message: "nope" },
      }),
    );
    await flush();

    // Then
    expect(counts).toEqual([]);
  });

  it("As a user, chains my loading screen never shows are not asked for peers", async () => {
    // Given
    enableSyncReporting({
      milestones: ["asset-hub"],
      peerCounts: ["asset-hub"],
    });

    // When
    const { raw } = await startRelay();

    // Then
    expect(peerRequests(raw)).toEqual([]);
  });

  it("As a user on a shell with no loading screen to feed, no peer counts are requested at all", async () => {
    // Given / When
    const { raw } = await startRelay();

    // Then
    expect(peerRequests(raw)).toEqual([]);
  });
});
