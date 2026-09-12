// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  ChainSyncTap,
  ParsedRpcMessage,
} from "@dotli/resolver/chain-sync";

let onChainSync: typeof import("@dotli/resolver/chain-sync").onChainSync;
let enableSyncReporting: typeof import("@dotli/resolver/chain-sync").enableSyncReporting;
let attachChainSync: typeof import("@dotli/resolver/chain-sync").attachChainSync;

beforeEach(async () => {
  vi.clearAllMocks();
  // The event history and the opt-in sets are module state, so each test
  // needs its own copy of the module.
  vi.resetModules();
  const mod = await import("@dotli/resolver/chain-sync");
  onChainSync = mod.onChainSync;
  enableSyncReporting = mod.enableSyncReporting;
  attachChainSync = mod.attachChainSync;
});

/**
 * A chain's JSON-RPC pipe, standing in for one truapi-provider connection.
 *
 * `deliver` plays a raw response through the tap the way `./provider` does,
 * and returns whether the tap claimed it. Anything it does not claim would
 * have reached polkadot-api.
 */
interface Pipe {
  tap: ChainSyncTap;
  sent: string[];
  deliver(raw: string): boolean;
  forwarded: string[];
  healthRequests(): string[];
}

function openPipe(chain: "relay" | "asset-hub"): Pipe | null {
  const sent: string[] = [];
  const forwarded: string[] = [];
  const tap = attachChainSync(chain, (raw) => sent.push(raw));
  if (tap === null) {
    return null;
  }
  return {
    tap,
    sent,
    forwarded,
    deliver(raw: string): boolean {
      const claimed = tap.intercept(JSON.parse(raw) as ParsedRpcMessage);
      if (!claimed) {
        forwarded.push(raw);
      }
      return claimed;
    },
    healthRequests: () => sent.filter((raw) => raw.includes("system_health")),
  };
}

/** Open a pipe that the test has already opted into reporting. */
function requirePipe(chain: "relay" | "asset-hub"): Pipe {
  const pipe = openPipe(chain);
  if (pipe === null) {
    throw new Error(`${chain} was not opted into sync reporting`);
  }
  return pipe;
}

const followReplyFor = (chain: string): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: `__dotli_lifecycle_follow__:${chain}`,
    result: "sub-1",
  });

const FOLLOW_REPLY = followReplyFor("relay");

/** The light client answers the follow with a method-not-found. */
const FOLLOW_UNSUPPORTED = JSON.stringify({
  jsonrpc: "2.0",
  id: "__dotli_lifecycle_follow__:relay",
  error: { code: -32601, message: "The method does not exist" },
});

/**
 * One `lifecycle_unstable_follow` notification.
 *
 * The subscription reports the chain's whole state every time, so a test
 * describes where the chain now stands rather than which milestone fired.
 */
function state(
  subscription: string,
  phase: { kind: string; at?: number; target?: number },
  numPeers: number,
  health: { kind: string; reason?: string } = { kind: "ok" },
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "lifecycle_unstable_followEvent",
    params: { subscription, result: { phase, numPeers, health } },
  });
}

/** The watchdog's verdict, in the shape `LifecycleHealth` serialises to. */
const OK = { kind: "ok" };
const stalled = (reason: string) => ({ kind: "stalled", reason });

function peerReport(seq: number, peers: number, isSyncing = true): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: `__dotli_health__:relay:${String(seq)}`,
    result: { isSyncing, peers, shouldHavePeers: true },
  });
}

describe("Light client sync reporting works", () => {
  it("As a user waiting for a domain, the shell learns when the first peer arrives and when the chain is ready", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(state("sub-1", { kind: "connecting" }, 0));
    pipe.deliver(state("sub-1", { kind: "ready" }, 2));

    // Then. A zero count is reported too: "no peers yet" and "not sampled
    // yet" are different things to a panel that shows the number.
    expect(seen).toEqual([
      { chain: "relay", kind: "peers", peers: 0, isSyncing: true },
      { chain: "relay", kind: "connecting" },
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "peers", peers: 2, isSyncing: false },
      { chain: "relay", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user on a chain with real catching up to do, the shell learns how far along the warp is", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(state("sub-1", { kind: "syncing", at: 20, target: 100 }, 3));
    pipe.deliver(state("sub-1", { kind: "syncing", at: 75, target: 100 }, 3));

    // Then
    expect(seen).toEqual([
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "peers", peers: 3, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress", at: 20, target: 100 },
      { chain: "relay", kind: "warpSyncProgress", at: 75, target: 100 },
    ]);
  });

  it("As a user whose relay finishes warping, the shell learns where the warp landed before the chain reports ready", () => {
    // Given a listener reading milestones in order must never see the warp
    // finish after the chain is already up.
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(state("sub-1", { kind: "syncing", at: 980, target: 1000 }, 3));
    pipe.deliver(state("sub-1", { kind: "ready" }, 3));

    // Then
    expect(seen).toEqual([
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "peers", peers: 3, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress", at: 980, target: 1000 },
      { chain: "relay", kind: "warpSyncFinished", finalized: 980 },
      { chain: "relay", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user on a chain that never warped, the shell reports no warp milestones at all", () => {
    // Given a parachain reaches ready without a warp to cover, so claiming it
    // finished one would be an invention.
    enableSyncReporting({ milestones: ["asset-hub"], peerCounts: [] });
    const pipe = requirePipe("asset-hub");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    pipe.deliver(followReplyFor("asset-hub"));
    pipe.deliver(state("sub-1", { kind: "connecting" }, 0));
    pipe.deliver(state("sub-1", { kind: "ready" }, 1));

    // Then
    expect(seen).toEqual([
      { chain: "asset-hub", kind: "peers", peers: 0, isSyncing: true },
      { chain: "asset-hub", kind: "connecting" },
      { chain: "asset-hub", kind: "firstPeer" },
      { chain: "asset-hub", kind: "peers", peers: 1, isSyncing: false },
      { chain: "asset-hub", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user whose connection drops mid-sync, the shell learns why it stalled and when it recovered", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(state("sub-1", { kind: "syncing" }, 1, OK));
    pipe.deliver(state("sub-1", { kind: "syncing" }, 0, stalled("noPeers")));
    pipe.deliver(state("sub-1", { kind: "syncing" }, 2, OK));

    // Then
    expect(seen).toEqual([
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "peers", peers: 1, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress" },
      { chain: "relay", kind: "peers", peers: 0, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress" },
      { chain: "relay", kind: "stalled", reason: "noPeers" },
      { chain: "relay", kind: "peers", peers: 2, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress" },
      { chain: "relay", kind: "recovered", reason: "noPeers" },
    ]);
  });

  it("As a user whose stall changes cause, I am told the new reason rather than the old one", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When the watchdog stays stalled but changes its mind about why.
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(state("sub-1", { kind: "syncing" }, 0, stalled("noPeers")));
    pipe.deliver(state("sub-1", { kind: "syncing" }, 1, stalled("noProgress")));

    // Then
    expect(
      seen.filter((e) => (e as { kind: string }).kind === "stalled"),
    ).toEqual([
      { chain: "relay", kind: "stalled", reason: "noPeers" },
      { chain: "relay", kind: "stalled", reason: "noProgress" },
    ]);
  });

  it("As a user opening the loading screen late, I see the newest sync state rather than a replay of every step", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(state("sub-1", { kind: "connecting" }, 0));
    pipe.deliver(state("sub-1", { kind: "syncing" }, 1));
    pipe.deliver(state("sub-1", { kind: "ready" }, 4));

    // When
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // Then the replay carries one event per kind, newest value only, in the
    // order each kind was first seen.
    expect(seen).toEqual([
      { chain: "relay", kind: "peers", peers: 4, isSyncing: false },
      { chain: "relay", kind: "connecting" },
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "warpSyncProgress" },
      { chain: "relay", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user whose sync recovered before I looked, I am not told it is still stalled", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(state("sub-1", { kind: "syncing" }, 0, stalled("noProgress")));
    pipe.deliver(state("sub-1", { kind: "syncing" }, 2, OK));

    // When
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // Then
    expect(seen).toContainEqual({
      chain: "relay",
      kind: "recovered",
      reason: "noProgress",
    });
    expect(seen).not.toContainEqual(
      expect.objectContaining({ kind: "stalled" }),
    );
  });

  it("As a user on a chain that reports its own peers, the shell stops polling for them", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      await vi.advanceTimersByTimeAsync(0);
      const before = pipe.healthRequests().length;

      // When the follow starts reporting, its pushed counts supersede polling.
      pipe.deliver(FOLLOW_REPLY);
      pipe.deliver(state("sub-1", { kind: "ready" }, 3));
      await vi.advanceTimersByTimeAsync(30_000);

      // Then
      expect(pipe.healthRequests().length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a user loading an app, the shell's own sync questions never reach the app's chain traffic", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const appResponse = JSON.stringify({
      jsonrpc: "2.0",
      id: "1-42",
      result: "0x00",
    });

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(state("sub-1", { kind: "ready" }, 1));
    pipe.deliver(appResponse);

    // Then
    expect(pipe.forwarded).toEqual([appResponse]);
  });
});

describe("Light client sync reporting falls back", () => {
  it("As a user on a light client without the lifecycle follow, the peer count still reaches my loading screen", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      const seen: unknown[] = [];
      onChainSync((event) => seen.push(event));

      // When
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(FOLLOW_UNSUPPORTED);
      pipe.deliver(peerReport(1, 6));

      // Then
      expect(seen).toEqual([
        { chain: "relay", kind: "peers", peers: 6, isSyncing: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a user with the network panel open, a polled peer count keeps refreshing", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(FOLLOW_UNSUPPORTED);
      pipe.deliver(peerReport(1, 2));
      const asked = pipe.healthRequests().length;

      // When
      await vi.advanceTimersByTimeAsync(1_000);

      // Then
      expect(pipe.healthRequests().length).toBe(asked + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a user with a steady connection, the peer count only changes when the number really changes", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      const seen: unknown[] = [];
      onChainSync((event) => seen.push(event));

      // When
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(FOLLOW_UNSUPPORTED);
      pipe.deliver(peerReport(1, 2));
      pipe.deliver(peerReport(2, 2));
      pipe.deliver(peerReport(3, 5));

      // Then
      expect(seen).toEqual([
        { chain: "relay", kind: "peers", peers: 2, isSyncing: true },
        { chain: "relay", kind: "peers", peers: 5, isSyncing: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a user, a peer count that arrives malformed never reaches my loading screen", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      const seen: unknown[] = [];
      onChainSync((event) => seen.push(event));

      // When
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(FOLLOW_UNSUPPORTED);
      pipe.deliver(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "__dotli_health__:relay:1",
          result: { isSyncing: true, peers: "3" },
        }),
      );
      pipe.deliver(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "__dotli_health__:relay:2",
          error: { code: -32000, message: "nope" },
        }),
      );

      // Then
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Light client sync reporting is opt-in", () => {
  it("As a user, a sync message meant for something else never moves my loading screen", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));
    const foreign = state("someone-elses-sub", { kind: "ready" }, 9);

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(foreign);

    // Then
    expect(seen).toEqual([]);
    expect(pipe.forwarded).toEqual([foreign]);
  });

  it("As a user, chains my loading screen never shows are not asked for peers", () => {
    // Given
    enableSyncReporting({
      milestones: ["asset-hub"],
      peerCounts: ["asset-hub"],
    });

    // When
    const pipe = openPipe("relay");

    // Then
    expect(pipe).toBeNull();
  });

  it("As a user on a shell with no loading screen to feed, no peer counts are requested at all", () => {
    // Given / When
    const pipe = openPipe("relay");

    // Then
    expect(pipe).toBeNull();
  });
});
