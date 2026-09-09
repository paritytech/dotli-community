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

describe("Light client sync reporting works", () => {
  it("As a user waiting for a domain, the shell learns when the first peer arrives and when the chain is ready", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(milestone("sub-1", "firstPeer"));
    pipe.deliver(milestone("sub-1", "bootstrapComplete"));

    // Then
    expect(milestones).toEqual([
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user on a chain with real catching up to do, the shell learns how far along the warp is", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(milestone("sub-1", "connecting"));
    pipe.deliver(
      milestone("sub-1", "warpSyncProgress", { at: 20, target: 100 }),
    );
    pipe.deliver(
      milestone("sub-1", "warpSyncProgress", { at: 75, target: 100 }),
    );
    pipe.deliver(milestone("sub-1", "warpSyncFinished", { finalized: 100 }));

    // Then
    expect(milestones).toEqual([
      { chain: "relay", kind: "connecting" },
      { chain: "relay", kind: "warpSyncProgress", at: 20, target: 100 },
      { chain: "relay", kind: "warpSyncProgress", at: 75, target: 100 },
      { chain: "relay", kind: "warpSyncFinished", finalized: 100 },
    ]);
  });

  it("As a user whose connection drops mid-sync, the shell learns why it stalled and when it recovered", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(milestone("sub-1", "stalled", { reason: "noPeers" }));
    pipe.deliver(milestone("sub-1", "recovered", { previously: "noPeers" }));

    // Then
    expect(milestones).toEqual([
      { chain: "relay", kind: "stalled", reason: "noPeers" },
      { chain: "relay", kind: "recovered", reason: "noPeers" },
    ]);
  });

  it("As a user opening the loading screen late, I see the newest sync state rather than a replay of every step", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(milestone("sub-1", "stalled", { reason: "noPeers" }));
    pipe.deliver(milestone("sub-1", "stalled", { reason: "syncNoProgress" }));
    pipe.deliver(milestone("sub-1", "firstPeer"));

    // When
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));

    // Then
    expect(milestones).toEqual([
      { chain: "relay", kind: "stalled", reason: "syncNoProgress" },
      { chain: "relay", kind: "firstPeer" },
    ]);
  });

  it("As a user whose sync recovered before I looked, I am not told it is still stalled", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(milestone("sub-1", "stalled", { reason: "noPeers" }));
    pipe.deliver(milestone("sub-1", "recovered", { previously: "noPeers" }));

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
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      const counts: unknown[] = [];
      onChainSync((event) => counts.push(event));

      // When
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(peerReport(1, 3));

      // Then
      expect(pipe.healthRequests()[0]).toContain(
        '"id":"__dotli_health__:relay:1"',
      );
      expect(counts).toEqual([
        { chain: "relay", kind: "peers", peers: 3, isSyncing: true },
      ]);
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
      const counts: unknown[] = [];
      onChainSync((event) => counts.push(event));

      // When
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(peerReport(1, 2));
      pipe.deliver(peerReport(2, 2));
      pipe.deliver(peerReport(3, 5));

      // Then
      expect(counts).toEqual([
        { chain: "relay", kind: "peers", peers: 2, isSyncing: true },
        { chain: "relay", kind: "peers", peers: 5, isSyncing: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a user opening the loading screen late, I still see the peer count already found", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(peerReport(1, 4));

      // When
      const counts: unknown[] = [];
      onChainSync((event) => counts.push(event));

      // Then
      expect(counts).toEqual([
        { chain: "relay", kind: "peers", peers: 4, isSyncing: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a user whose chain finished syncing, it stops being asked for peers every second", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(FOLLOW_REPLY);
      pipe.deliver(peerReport(1, 3));

      // When
      pipe.deliver(milestone("sub-1", "bootstrapComplete"));
      const asked = pipe.healthRequests().length;
      await vi.advanceTimersByTimeAsync(10_000);

      // Then
      expect(pipe.healthRequests().length).toBe(asked);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a user with the network panel open, the peer count keeps refreshing long after the chain is up", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(FOLLOW_REPLY);
      pipe.deliver(peerReport(1, 3));
      pipe.deliver(milestone("sub-1", "bootstrapComplete"));
      const asked = pipe.healthRequests().length;

      // When
      await vi.advanceTimersByTimeAsync(15_000);

      // Then
      expect(pipe.healthRequests().length).toBe(asked + 1);
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
    pipe.deliver(milestone("sub-1", "firstPeer"));
    pipe.deliver(appResponse);

    // Then
    expect(pipe.forwarded).toEqual([appResponse]);
  });
});

describe("Light client sync reporting fails", () => {
  it("As a user, a sync message meant for something else never moves my loading screen", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));
    const foreign = milestone("someone-elses-sub", "firstPeer");

    // When
    pipe.deliver(FOLLOW_REPLY);
    pipe.deliver(foreign);

    // Then
    expect(milestones).toEqual([]);
    expect(pipe.forwarded).toEqual([foreign]);
  });

  it("As a user, sync milestones the shell has no wording for are ignored", () => {
    // Given
    enableSyncReporting({ milestones: ["relay"], peerCounts: [] });
    const pipe = requirePipe("relay");
    const milestones: unknown[] = [];
    onChainSync((event) => milestones.push(event));
    const appResponse = JSON.stringify({ jsonrpc: "2.0", id: "1-1" });

    // When
    pipe.deliver(FOLLOW_REPLY);
    // `modeDecision` is real and we deliberately have nothing to say about it.
    pipe.deliver(milestone("sub-1", "modeDecision", { mode: "warpSync" }));
    pipe.deliver(appResponse);

    // Then
    expect(milestones).toEqual([]);
    expect(pipe.forwarded).toEqual([appResponse]);
  });

  it("As a user, a peer count that arrives malformed never reaches my loading screen", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      const counts: unknown[] = [];
      onChainSync((event) => counts.push(event));

      // When
      await vi.advanceTimersByTimeAsync(0);
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
      expect(counts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("As a user on a light client without the lifecycle follow, the peer count still reaches my loading screen", async () => {
    // Given
    vi.useFakeTimers();
    try {
      enableSyncReporting({ milestones: ["relay"], peerCounts: ["relay"] });
      const pipe = requirePipe("relay");
      const events: unknown[] = [];
      onChainSync((event) => events.push(event));

      // When
      await vi.advanceTimersByTimeAsync(0);
      pipe.deliver(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "__dotli_lifecycle_follow__:relay",
          error: { code: -32601, message: "Method not found" },
        }),
      );
      pipe.deliver(peerReport(1, 6));

      // Then
      expect(events).toEqual([
        { chain: "relay", kind: "peers", peers: 6, isSyncing: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
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
