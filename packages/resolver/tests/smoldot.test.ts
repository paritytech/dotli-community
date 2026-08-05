// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Queue-backed chain mocks: tests push raw JSON-RPC responses and the
// chain tap's pump consumes them exactly as it does smoldot's output.
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
    const waiters: ((s: string) => void)[] = [];
    const chain: MockChain = {
      sendJsonRpc: vi.fn(),
      nextJsonRpcResponse: () =>
        new Promise<string>((resolve) => {
          const next = queue.shift();
          if (next !== undefined) {
            resolve(next);
          } else {
            waiters.push(resolve);
          }
        }),
      jsonRpcResponses: (async function* () {})(),
      remove: vi.fn(),
      push(raw: string) {
        const waiter = waiters.shift();
        if (waiter !== undefined) {
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
let onLifecycle: typeof import("@dotli/resolver/smoldot").onLifecycle;
let onHealth: typeof import("@dotli/resolver/smoldot").onHealth;
let enableHealthPolling: typeof import("@dotli/resolver/smoldot").enableHealthPolling;

beforeEach(async () => {
  vi.clearAllMocks();
  chainMocks.chains.length = 0;
  vi.resetModules();
  const mod = await import("@dotli/resolver/smoldot");
  getSmoldot = mod.getSmoldot;
  getRelayChain = mod.getRelayChain;
  onLifecycle = mod.onLifecycle;
  onHealth = mod.onHealth;
  enableHealthPolling = mod.enableHealthPolling;
});

// Let the tap's pump loop drain everything pushed so far.
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
}

async function relayMock(): Promise<
  (typeof chainMocks.chains)[number] & object
> {
  await getRelayChain();
  const chain = chainMocks.chains.at(-1);
  if (chain === undefined) {
    throw new Error("relay chain mock was not created");
  }
  return chain;
}

const FOLLOW_REPLY = JSON.stringify({
  jsonrpc: "2.0",
  id: "__dotli_lifecycle_follow__:relay",
  result: "sub-1",
});

function followEvent(
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

function healthReply(seq: number, peers: number, isSyncing = true): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: `__dotli_health__:relay:${String(seq)}`,
    result: { isSyncing, peers, shouldHavePeers: true },
  });
}

function healthCalls(chain: { sendJsonRpc: ReturnType<typeof vi.fn> }) {
  return chain.sendJsonRpc.mock.calls
    .map((call) => call[0] as string)
    .filter((raw) => raw.includes("system_health"));
}

describe("getSmoldot", () => {
  it("returns the same instance on repeated calls", () => {
    const a = getSmoldot();
    const b = getSmoldot();
    expect(a).toBe(b);
  });
});

describe("getRelayChain", () => {
  it("returns a promise", () => {
    const result = getRelayChain();
    expect(result).toBeInstanceOf(Promise);
  });

  it("deduplicates concurrent calls", () => {
    const a = getRelayChain();
    const b = getRelayChain();
    expect(a).toBe(b);
  });

  it("resolves to a chain object", async () => {
    const chain = await getRelayChain();
    expect(chain).toBeDefined();
    expect(typeof chain.sendJsonRpc).toBe("function");
  });
});

describe("onLifecycle", () => {
  it("delivers events for the chain once the follow reply is seen", async () => {
    const chain = await relayMock();
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    chain.push(FOLLOW_REPLY);
    chain.push(followEvent("sub-1", "firstPeer"));
    chain.push(followEvent("sub-1", "bootstrapComplete"));
    await flush();

    expect(events).toEqual([
      { chain: "relay", kind: "firstPeer" },
      { chain: "relay", kind: "bootstrapComplete" },
    ]);
  });

  it("forwards notifications from unknown subscriptions to the chain consumer", async () => {
    const tapped = await getRelayChain();
    const chain = chainMocks.chains.at(-1);
    if (chain === undefined) {
      throw new Error("relay chain mock was not created");
    }
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    chain.push(FOLLOW_REPLY);
    const foreign = followEvent("someone-elses-sub", "firstPeer");
    chain.push(foreign);
    await flush();

    expect(events).toEqual([]);
    await expect(tapped.nextJsonRpcResponse()).resolves.toBe(foreign);
  });

  it("consumes our traffic so the chain consumer never sees it", async () => {
    const tapped = await getRelayChain();
    const chain = chainMocks.chains.at(-1);
    if (chain === undefined) {
      throw new Error("relay chain mock was not created");
    }

    chain.push(FOLLOW_REPLY);
    chain.push(followEvent("sub-1", "firstPeer"));
    const papiResponse = JSON.stringify({
      jsonrpc: "2.0",
      id: "1-42",
      result: "0x00",
    });
    chain.push(papiResponse);
    await flush();

    // Only the polkadot-api response comes through; ours were consumed.
    await expect(tapped.nextJsonRpcResponse()).resolves.toBe(papiResponse);
  });

  it("carries the stall reason and the recovery cause", async () => {
    const chain = await relayMock();
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    chain.push(FOLLOW_REPLY);
    chain.push(followEvent("sub-1", "stalled", { reason: "noPeers" }));
    chain.push(followEvent("sub-1", "recovered", { previously: "noPeers" }));
    await flush();

    expect(events).toEqual([
      { chain: "relay", kind: "stalled", reason: "noPeers" },
      { chain: "relay", kind: "recovered", reason: "noPeers" },
    ]);
  });

  it("replays only the latest event per chain and kind to a late subscriber", async () => {
    const chain = await relayMock();
    chain.push(FOLLOW_REPLY);
    chain.push(followEvent("sub-1", "stalled", { reason: "noPeers" }));
    chain.push(followEvent("sub-1", "stalled", { reason: "syncNoProgress" }));
    chain.push(followEvent("sub-1", "firstPeer"));
    await flush();

    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    expect(events).toEqual([
      { chain: "relay", kind: "stalled", reason: "syncNoProgress" },
      { chain: "relay", kind: "firstPeer" },
    ]);
  });

  it("replays only the newer half of a stall and recovery pair", async () => {
    const chain = await relayMock();
    chain.push(FOLLOW_REPLY);
    chain.push(followEvent("sub-1", "stalled", { reason: "noPeers" }));
    chain.push(followEvent("sub-1", "recovered", { previously: "noPeers" }));
    await flush();

    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    expect(events).toEqual([
      { chain: "relay", kind: "recovered", reason: "noPeers" },
    ]);
  });

  it("ignores kinds outside the allowlist but still consumes them", async () => {
    const tapped = await getRelayChain();
    const chain = chainMocks.chains.at(-1);
    if (chain === undefined) {
      throw new Error("relay chain mock was not created");
    }
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    chain.push(FOLLOW_REPLY);
    chain.push(followEvent("sub-1", "warpSyncProgress", { at: 5, target: 9 }));
    const papiResponse = JSON.stringify({ jsonrpc: "2.0", id: "1-1" });
    chain.push(papiResponse);
    await flush();

    expect(events).toEqual([]);
    await expect(tapped.nextJsonRpcResponse()).resolves.toBe(papiResponse);
  });

  it("stops delivering after unsubscribe", async () => {
    const chain = await relayMock();
    const events: unknown[] = [];
    const unsubscribe = onLifecycle((event) => events.push(event));

    chain.push(FOLLOW_REPLY);
    chain.push(followEvent("sub-1", "firstPeer"));
    await flush();
    unsubscribe();
    chain.push(followEvent("sub-1", "bootstrapComplete"));
    await flush();

    expect(events).toEqual([{ chain: "relay", kind: "firstPeer" }]);
  });
});

describe("onHealth", () => {
  // Fake timers keep leaked poller resends (2s timeout) from bleeding
  // between tests through the mock chains.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls system_health immediately and emits the parsed sample", async () => {
    enableHealthPolling(["relay"]);
    const chain = await relayMock();

    const sent = healthCalls(chain);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]).toContain('"id":"__dotli_health__:relay:1"');

    const events: unknown[] = [];
    onHealth((event) => events.push(event));
    chain.push(healthReply(1, 3));
    await flush();

    expect(events).toEqual([{ chain: "relay", peers: 3, isSyncing: true }]);
  });

  it("does not poll chains outside the allowlist", async () => {
    enableHealthPolling(["asset-hub"]);
    const chain = await relayMock();
    expect(healthCalls(chain)).toEqual([]);
  });

  it("does not poll when polling was never enabled", async () => {
    const chain = await relayMock();
    expect(healthCalls(chain)).toEqual([]);
  });

  it("emits only when the sample changes", async () => {
    enableHealthPolling(["relay"]);
    const chain = await relayMock();

    const events: unknown[] = [];
    onHealth((event) => events.push(event));
    chain.push(healthReply(1, 2));
    chain.push(healthReply(2, 2));
    chain.push(healthReply(3, 5));
    await flush();

    expect(events).toEqual([
      { chain: "relay", peers: 2, isSyncing: true },
      { chain: "relay", peers: 5, isSyncing: true },
    ]);
  });

  it("replays the last sample to a late subscriber", async () => {
    enableHealthPolling(["relay"]);
    const chain = await relayMock();

    chain.push(healthReply(1, 4));
    await flush();

    const events: unknown[] = [];
    onHealth((event) => events.push(event));
    expect(events).toEqual([{ chain: "relay", peers: 4, isSyncing: true }]);
  });

  it("stops polling once the chain bootstrap completes", async () => {
    enableHealthPolling(["relay"]);
    const chain = await relayMock();

    chain.push(FOLLOW_REPLY);
    chain.push(healthReply(1, 3));
    chain.push(followEvent("sub-1", "bootstrapComplete"));
    await flush();

    const sentBefore = healthCalls(chain).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(healthCalls(chain).length).toBe(sentBefore);
  });

  it("rejects malformed health payloads", async () => {
    enableHealthPolling(["relay"]);
    const chain = await relayMock();

    const events: unknown[] = [];
    onHealth((event) => events.push(event));
    // peers is not an integer
    chain.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "__dotli_health__:relay:1",
        result: { isSyncing: true, peers: "3" },
      }),
    );
    // error response, no result
    chain.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "__dotli_health__:relay:2",
        error: { code: -32000, message: "nope" },
      }),
    );
    await flush();

    expect(events).toEqual([]);
  });
});
