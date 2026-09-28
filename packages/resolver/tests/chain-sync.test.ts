// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  ChainSyncTap,
  ParsedRpcMessage,
} from "@dotli/resolver/chain-sync";

// A getter rather than a literal, so a test can flip it to reach the
// metrics-stripped path without tearing down the module registry.
const metrics = { enabled: true };

vi.mock("@dotli/metrics/metrics", () => ({
  m: {
    get enabled() {
      return metrics.enabled;
    },
  },
}));

let onChainSync: typeof import("@dotli/resolver/chain-sync").onChainSync;
let enableSyncReporting: typeof import("@dotli/resolver/chain-sync").enableSyncReporting;
let attachChainSync: typeof import("@dotli/resolver/chain-sync").attachChainSync;

beforeEach(async () => {
  vi.clearAllMocks();
  metrics.enabled = true;
  // The event history and the opt-in sets are module state, so each test
  // needs its own copy of the module.
  vi.resetModules();
  const mod = await import("@dotli/resolver/chain-sync");
  onChainSync = mod.onChainSync;
  enableSyncReporting = mod.enableSyncReporting;
  attachChainSync = mod.attachChainSync;
});

type Lifecycle = import("@parity/truapi-provider").ChainLifecycle;

/**
 * One chain connection, standing in for truapi-provider's.
 *
 * `push` plays a lifecycle snapshot through the watch, `deliver` plays a raw
 * response through the tap the way `./provider` does, and returns whether the
 * tap claimed it. Anything it does not claim would have reached polkadot-api.
 */
interface Pipe {
  tap: ChainSyncTap;
  sent: string[];
  forwarded: string[];
  closed(): boolean;
  push(...states: Lifecycle[]): Promise<void>;
  deliver(raw: string): boolean;
}

function openPipe(chain: "relay" | "asset-hub"): Pipe | null {
  const sent: string[] = [];
  const forwarded: string[] = [];
  const queued: (Lifecycle | undefined)[] = [];
  let waiting: ((state: Lifecycle | undefined) => void) | null = null;
  let closed = false;
  const offer = (state: Lifecycle | undefined): void => {
    if (waiting === null) {
      queued.push(state);
      return;
    }
    const resolve = waiting;
    waiting = null;
    resolve(state);
  };
  const tap = attachChainSync(
    chain,
    (raw) => sent.push(raw),
    () => ({
      next: () =>
        queued.length > 0
          ? Promise.resolve(queued.shift())
          : new Promise((resolve) => {
              waiting = resolve;
            }),
      close: () => {
        closed = true;
        offer(undefined);
      },
    }),
  );
  if (tap === null) {
    return null;
  }
  return {
    tap,
    sent,
    forwarded,
    closed: () => closed,
    async push(...states: Lifecycle[]): Promise<void> {
      for (const state of states) {
        offer(state);
        // Let the tap's read loop take the snapshot before the next one.
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    deliver(raw: string): boolean {
      const claimed = tap.intercept(JSON.parse(raw) as ParsedRpcMessage);
      if (!claimed) {
        forwarded.push(raw);
      }
      return claimed;
    },
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

/**
 * One lifecycle snapshot.
 *
 * The watch reports the whole chain state every time, so a test describes
 * where the chain now stands rather than which milestone fired.
 */
function state(
  phase: Lifecycle["phase"],
  peers: number,
  health: Lifecycle["health"] = { kind: "ok" },
): Lifecycle {
  return { phase, peers, health };
}

const CONNECTING = { kind: "connecting" } as const;
const READY = { kind: "ready" } as const;
const syncing = (at: number, target: number) =>
  ({ kind: "syncing", at, target }) as const;
const OK = { kind: "ok" } as const;
const stalled = (reason: "noPeers" | "noProgress") =>
  ({ kind: "stalled", reason }) as const;

describe("Light client sync reporting works", () => {
  it("As a user waiting for a domain, the shell learns when the first peer arrives and when the chain is ready", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    await pipe.push(state(CONNECTING, 0), state(READY, 2));

    // Then
    expect(seen).toEqual([
      { chain: "relay", kind: "peers", peers: 0, isSyncing: true },
      { chain: "relay", kind: "connecting" },
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "peers", peers: 2, isSyncing: false },
      { chain: "relay", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user on a chain with real catching up to do, the shell learns how far along the warp is", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    await pipe.push(state(syncing(20, 100), 3), state(syncing(75, 100), 3));

    // Then
    expect(seen).toEqual([
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "peers", peers: 3, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress", at: 20, target: 100 },
      { chain: "relay", kind: "warpSyncProgress", at: 75, target: 100 },
    ]);
  });

  it("As a user whose relay finishes warping, the shell learns where the warp landed before the chain reports ready", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    await pipe.push(state(syncing(980, 1000), 3), state(READY, 3));

    // Then
    expect(seen).toEqual([
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "peers", peers: 3, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress", at: 980, target: 1000 },
      { chain: "relay", kind: "warpSyncFinished", finalized: 980 },
      { chain: "relay", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user on a chain that never warped, the shell reports no warp milestones at all", async () => {
    // Given
    enableSyncReporting(["asset-hub"]);
    const pipe = requirePipe("asset-hub");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    await pipe.push(state(CONNECTING, 0), state(READY, 1));

    // Then
    expect(seen).toEqual([
      { chain: "asset-hub", kind: "peers", peers: 0, isSyncing: true },
      { chain: "asset-hub", kind: "connecting" },
      { chain: "asset-hub", kind: "firstPeer" },
      { chain: "asset-hub", kind: "peers", peers: 1, isSyncing: false },
      { chain: "asset-hub", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user whose connection drops mid-sync, the shell learns why it stalled and when it recovered", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    await pipe.push(
      state(syncing(10, 50), 1, OK),
      state(syncing(10, 50), 0, stalled("noPeers")),
      state(syncing(10, 50), 2, OK),
    );

    // Then
    expect(seen).toEqual([
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "peers", peers: 1, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress", at: 10, target: 50 },
      { chain: "relay", kind: "peers", peers: 0, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress", at: 10, target: 50 },
      { chain: "relay", kind: "stalled", reason: "noPeers" },
      { chain: "relay", kind: "peers", peers: 2, isSyncing: true },
      { chain: "relay", kind: "warpSyncProgress", at: 10, target: 50 },
      { chain: "relay", kind: "recovered", reason: "noPeers" },
    ]);
  });

  it("As a user whose stall changes cause, I am told the new reason rather than the old one", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    await pipe.push(
      state(syncing(10, 50), 0, stalled("noPeers")),
      state(syncing(10, 50), 1, stalled("noProgress")),
    );

    // Then
    expect(
      seen.filter((e) => (e as { kind: string }).kind === "stalled"),
    ).toEqual([
      { chain: "relay", kind: "stalled", reason: "noPeers" },
      { chain: "relay", kind: "stalled", reason: "noProgress" },
    ]);
  });

  it("As a user with a steady connection, the peer count only changes when the number really changes", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // When
    await pipe.push(
      state(CONNECTING, 2),
      state(CONNECTING, 2, stalled("noProgress")),
      state(CONNECTING, 5, stalled("noProgress")),
    );

    // Then
    expect(
      seen.filter((e) => (e as { kind: string }).kind === "peers"),
    ).toEqual([
      { chain: "relay", kind: "peers", peers: 2, isSyncing: true },
      { chain: "relay", kind: "peers", peers: 5, isSyncing: true },
    ]);
  });

  it("As a user opening the loading screen late, I see the newest sync state rather than a replay of every step", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    await pipe.push(
      state(CONNECTING, 0),
      state(syncing(1, 4), 1),
      state(READY, 4),
    );

    // When
    const seen: unknown[] = [];
    onChainSync((event) => seen.push(event));

    // Then
    expect(seen).toEqual([
      { chain: "relay", kind: "peers", peers: 4, isSyncing: false },
      { chain: "relay", kind: "connecting" },
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "warpSyncProgress", at: 1, target: 4 },
      { chain: "relay", kind: "warpSyncFinished", finalized: 1 },
      { chain: "relay", kind: "bootstrapComplete" },
    ]);
  });

  it("As a user whose sync recovered before I looked, I am not told it is still stalled", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    await pipe.push(
      state(syncing(10, 50), 0, stalled("noProgress")),
      state(syncing(10, 50), 2, OK),
    );

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

  it("As a maintainer, the peers a chain held when it came up are recorded once", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    const details: unknown[] = [];
    const mod = await import("@dotli/resolver/chain-sync");
    mod.onChainDetail((detail) => details.push(detail));

    // When
    await pipe.push(state(READY, 1), state(syncing(5, 9), 1), state(READY, 1));
    const claimed = pipe.deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "__dotli_peers__:relay",
        result: [{ peerId: "12D3KooW", roles: "FULL", bestNumber: 9 }],
      }),
    );

    // Then
    expect(
      pipe.sent.filter((raw) => raw.includes("system_peers")),
    ).toHaveLength(1);
    expect(claimed).toBe(true);
    expect(details).toEqual([
      {
        chain: "relay",
        peers: [{ peerId: "12D3KooW", roles: "FULL", bestNumber: 9 }],
      },
    ]);
  });

  it("As a user on a build without metrics, the chain is never asked for its peers", async () => {
    // Given
    metrics.enabled = false;
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");

    // When
    await pipe.push(state(READY, 1));

    // Then
    expect(pipe.sent).toEqual([]);
  });

  it("As a user loading an app, the sync questions the shell asks never reach the chain traffic of the app", async () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");
    const appResponse = JSON.stringify({
      jsonrpc: "2.0",
      id: "1-42",
      result: "0x00",
    });

    // When
    await pipe.push(state(READY, 1));
    pipe.deliver(appResponse);

    // Then
    expect(pipe.forwarded).toEqual([appResponse]);
  });

  it("As a user leaving the page, stopping the tap closes the lifecycle watch", () => {
    // Given
    enableSyncReporting(["relay"]);
    const pipe = requirePipe("relay");

    // When
    pipe.tap.stop();

    // Then
    expect(pipe.closed()).toBe(true);
  });
});

describe("Light client sync reporting is opt-in", () => {
  it("As a user, chains my loading screen never shows are not watched", () => {
    // Given
    enableSyncReporting(["asset-hub"]);

    // When
    const pipe = openPipe("relay");

    // Then
    expect(pipe).toBeNull();
  });

  it("As a user on a shell with no loading screen to feed, no chain is watched at all", () => {
    // Given
    const pipe = openPipe("relay");

    // Then
    expect(pipe).toBeNull();
  });

  it("As a user, a chain that refuses a lifecycle watch still passes its traffic through", () => {
    // Given
    enableSyncReporting(["relay"]);
    const tap = attachChainSync(
      "relay",
      () => undefined,
      () => {
        throw new Error("chain is not connected");
      },
    );
    const appResponse = { jsonrpc: "2.0", id: "1-1", result: "0x00" };

    // Then
    expect(tap?.intercept(appResponse)).toBe(false);
  });
});

describe("Chain detail reporting works", () => {
  it("As a maintainer, a second connection to the same chain cannot rewrite a warm start as cold", async () => {
    // Given
    const mod = await import("@dotli/resolver/chain-sync");
    const { getActiveServicesConfig } = await import("@dotli/config/network");
    const genesis = getActiveServicesConfig().bulletin.genesis;
    const seen: unknown[] = [];
    mod.onChainDetail((detail) => seen.push(detail));

    // When
    mod.reportDbCache(genesis, true);
    mod.reportDbCache(genesis, false);

    // Then
    expect(seen).toEqual([{ chain: "bulletin", dbCache: "hit" }]);
  });

  it("As a maintainer, a panel opened late still shows the warm start rather than the later miss", async () => {
    // Given
    const mod = await import("@dotli/resolver/chain-sync");
    const { getActiveServicesConfig } = await import("@dotli/config/network");
    const genesis = getActiveServicesConfig().bulletin.genesis;
    mod.reportDbCache(genesis, true);
    mod.reportDbCache(genesis, false);

    // When
    const seen: unknown[] = [];
    mod.onChainDetail((detail) => seen.push(detail));

    // Then
    expect(seen).toEqual([{ chain: "bulletin", dbCache: "hit" }]);
  });
});
