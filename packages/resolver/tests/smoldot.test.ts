// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("polkadot-api/smoldot", () => ({
  start: vi.fn(() => ({
    addChain: vi.fn().mockResolvedValue({
      sendJsonRpc: vi.fn(),
      nextJsonRpcResponse: vi.fn(),
      jsonRpcResponses: (async function* () {})(),
      remove: vi.fn(),
    }),
  })),
}));

vi.mock("polkadot-api/smoldot/from-worker", () => {
  const mockAddChain = vi.fn().mockResolvedValue({
    sendJsonRpc: vi.fn(),
    nextJsonRpcResponse: vi.fn(),
    jsonRpcResponses: (async function* () {})(),
    remove: vi.fn(),
  });
  return {
    startFromWorker: vi.fn(() => ({
      addChain: mockAddChain,
    })),
  };
});

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
  // The mocked chain object is shared by the module factories above, so its
  // call history would otherwise leak across tests.
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import("@dotli/resolver/smoldot");
  getSmoldot = mod.getSmoldot;
  getRelayChain = mod.getRelayChain;
  onLifecycle = mod.onLifecycle;
  onHealth = mod.onHealth;
  enableHealthPolling = mod.enableHealthPolling;
});

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

// Grab the logCallback the module hands to smoldot so tests can feed it
// synthetic json-rpc log lines.
async function captureLogCallback(): Promise<
  (level: number, target: string, message: string) => void
> {
  getSmoldot();
  const { startFromWorker } = await import("polkadot-api/smoldot/from-worker");
  const options = vi.mocked(startFromWorker).mock.lastCall?.[1];
  if (options?.logCallback === undefined) {
    throw new Error("logCallback was not passed to startFromWorker");
  }
  return options.logCallback;
}

// Production line shape: smoldot logs every response on the chain's
// `json-rpc-<id>` target as `json-rpc-response-yielded; response=<json>`.
function responseLine(payload: unknown): string {
  return `json-rpc-response-yielded; response=${JSON.stringify(payload)}`;
}

function followEventLine(
  kind: string,
  extra: Record<string, unknown> = {},
): string {
  return responseLine({
    jsonrpc: "2.0",
    method: "lifecycle_unstable_followEvent",
    params: { subscription: "lf-1", result: { kind, ...extra } },
  });
}

function followReplyLine(logicalKey: string): string {
  return responseLine({
    jsonrpc: "2.0",
    id: `__dotli_lifecycle_follow__:${logicalKey}`,
    result: "lf-1",
  });
}

function healthLine(
  logicalKey: string,
  seq: number,
  peers: number,
  isSyncing = true,
): string {
  return responseLine({
    jsonrpc: "2.0",
    id: `__dotli_health__:${logicalKey}:${String(seq)}`,
    result: { isSyncing, peers, shouldHavePeers: true },
  });
}

describe("onLifecycle", () => {
  it("delivers events keyed by the logical chain once the follow reply is seen", async () => {
    const logCallback = await captureLogCallback();
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    logCallback(4, "json-rpc-asset-hub-paseo", followReplyLine("asset-hub"));
    logCallback(4, "json-rpc-asset-hub-paseo", followEventLine("firstPeer"));
    logCallback(
      4,
      "json-rpc-asset-hub-paseo",
      followEventLine("bootstrapComplete"),
    );

    expect(events).toEqual([
      { chain: "asset-hub", kind: "firstPeer" },
      { chain: "asset-hub", kind: "bootstrapComplete" },
    ]);
  });

  it("falls back to the log target name when no follow reply mapped it", async () => {
    const logCallback = await captureLogCallback();
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    logCallback(4, "json-rpc-asset-hub-paseo", followEventLine("firstPeer"));

    expect(events).toEqual([{ chain: "asset-hub-paseo", kind: "firstPeer" }]);
  });

  it("carries the stall reason and the recovery cause", async () => {
    const logCallback = await captureLogCallback();
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    logCallback(4, "json-rpc-paseo", followReplyLine("relay"));
    logCallback(
      4,
      "json-rpc-paseo",
      followEventLine("stalled", { reason: "noPeers" }),
    );
    logCallback(
      4,
      "json-rpc-paseo",
      followEventLine("recovered", { previously: "noPeers" }),
    );

    expect(events).toEqual([
      { chain: "relay", kind: "stalled", reason: "noPeers" },
      { chain: "relay", kind: "recovered", reason: "noPeers" },
    ]);
  });

  it("replays only the latest event per chain and kind to a late subscriber", async () => {
    const logCallback = await captureLogCallback();
    logCallback(4, "json-rpc-paseo", followReplyLine("relay"));
    logCallback(
      4,
      "json-rpc-paseo",
      followEventLine("stalled", { reason: "noPeers" }),
    );
    logCallback(
      4,
      "json-rpc-paseo",
      followEventLine("stalled", { reason: "syncNoProgress" }),
    );
    logCallback(4, "json-rpc-paseo", followEventLine("firstPeer"));

    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    expect(events).toEqual([
      { chain: "relay", kind: "stalled", reason: "syncNoProgress" },
      { chain: "relay", kind: "firstPeer" },
    ]);
  });

  it("replays only the newer half of a stall and recovery pair", async () => {
    const logCallback = await captureLogCallback();
    logCallback(4, "json-rpc-paseo", followReplyLine("relay"));
    logCallback(
      4,
      "json-rpc-paseo",
      followEventLine("stalled", { reason: "noPeers" }),
    );
    logCallback(
      4,
      "json-rpc-paseo",
      followEventLine("recovered", { previously: "noPeers" }),
    );

    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    expect(events).toEqual([
      { chain: "relay", kind: "recovered", reason: "noPeers" },
    ]);
  });

  it("ignores malformed, unknown-kind, and non-lifecycle payloads", async () => {
    const logCallback = await captureLogCallback();
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    // Mentions the method but carries no response payload.
    logCallback(4, "json-rpc-paseo", "sent lifecycle_unstable_followEvent");
    // Request echo, not a response.
    logCallback(
      4,
      "json-rpc-paseo",
      'json-rpc-request-queued; request={"method":"lifecycle_unstable_followEvent"}',
    );
    // Truncated JSON (smoldot caps the logged payload at 250 chars).
    logCallback(
      4,
      "json-rpc-paseo",
      'json-rpc-response-yielded; response={"method":"lifecycle_unstable_followEvent"',
    );
    // A different method that happens to mention the string.
    logCallback(
      4,
      "json-rpc-paseo",
      followEventLine("firstPeer").replace("followEvent", "followEvent_other"),
    );
    // A kind outside the allowlist (smoldot emits more kinds than we consume).
    logCallback(4, "json-rpc-paseo", followEventLine("warpSyncProgress"));
    // Right payload on a non json-rpc target.
    logCallback(4, "sync-service-paseo", followEventLine("firstPeer"));

    expect(events).toEqual([]);
  });

  it("stops delivering after unsubscribe", async () => {
    const logCallback = await captureLogCallback();
    const events: unknown[] = [];
    const unsubscribe = onLifecycle((event) => events.push(event));

    logCallback(4, "json-rpc-paseo", followEventLine("firstPeer"));
    unsubscribe();
    logCallback(4, "json-rpc-paseo", followEventLine("bootstrapComplete"));

    expect(events).toEqual([{ chain: "paseo", kind: "firstPeer" }]);
  });
});

describe("onHealth", () => {
  // Fake timers keep leaked poller resends (2s timeout) from bleeding
  // between tests through the shared mock chain.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function relaySendJsonRpc(): Promise<ReturnType<typeof vi.fn>> {
    const { startFromWorker } =
      await import("polkadot-api/smoldot/from-worker");
    const client = vi.mocked(startFromWorker).mock.results.at(-1)?.value as {
      addChain: ReturnType<typeof vi.fn>;
    };
    const chain = (await client.addChain.mock.results.at(-1)?.value) as {
      sendJsonRpc: ReturnType<typeof vi.fn>;
    };
    return chain.sendJsonRpc;
  }

  function healthCalls(sendJsonRpc: ReturnType<typeof vi.fn>): string[] {
    return sendJsonRpc.mock.calls
      .map((call) => call[0] as string)
      .filter((raw) => raw.includes("system_health"));
  }

  it("polls system_health immediately and emits the parsed sample", async () => {
    enableHealthPolling();
    const logCallback = await captureLogCallback();
    await getRelayChain();
    const sendJsonRpc = await relaySendJsonRpc();

    const sent = healthCalls(sendJsonRpc);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]).toContain('"id":"__dotli_health__:relay:1"');

    const events: unknown[] = [];
    onHealth((event) => events.push(event));
    logCallback(4, "json-rpc-paseo", healthLine("relay", 1, 3));

    expect(events).toEqual([{ chain: "relay", peers: 3, isSyncing: true }]);
  });

  it("emits only when the sample changes", async () => {
    enableHealthPolling();
    const logCallback = await captureLogCallback();
    await getRelayChain();

    const events: unknown[] = [];
    onHealth((event) => events.push(event));
    logCallback(4, "json-rpc-paseo", healthLine("relay", 1, 2));
    logCallback(4, "json-rpc-paseo", healthLine("relay", 2, 2));
    logCallback(4, "json-rpc-paseo", healthLine("relay", 3, 5));

    expect(events).toEqual([
      { chain: "relay", peers: 2, isSyncing: true },
      { chain: "relay", peers: 5, isSyncing: true },
    ]);
  });

  it("replays the last sample to a late subscriber", async () => {
    enableHealthPolling();
    const logCallback = await captureLogCallback();
    await getRelayChain();

    logCallback(4, "json-rpc-paseo", healthLine("relay", 1, 4));

    const events: unknown[] = [];
    onHealth((event) => events.push(event));
    expect(events).toEqual([{ chain: "relay", peers: 4, isSyncing: true }]);
  });

  it("stops polling once the chain bootstrap completes", async () => {
    enableHealthPolling();
    const logCallback = await captureLogCallback();
    await getRelayChain();
    const sendJsonRpc = await relaySendJsonRpc();

    // Map the log target to the logical key, then finish bootstrap.
    logCallback(4, "json-rpc-paseo", followReplyLine("relay"));
    logCallback(4, "json-rpc-paseo", healthLine("relay", 1, 3));
    logCallback(4, "json-rpc-paseo", followEventLine("bootstrapComplete"));

    const sentBefore = healthCalls(sendJsonRpc).length;
    vi.advanceTimersByTime(30_000);
    expect(healthCalls(sendJsonRpc).length).toBe(sentBefore);
  });

  it("does not poll when polling was never enabled", async () => {
    await captureLogCallback();
    await getRelayChain();
    const sendJsonRpc = await relaySendJsonRpc();
    expect(healthCalls(sendJsonRpc)).toEqual([]);
  });

  it("rejects malformed health payloads", async () => {
    enableHealthPolling();
    const logCallback = await captureLogCallback();
    await getRelayChain();

    const events: unknown[] = [];
    onHealth((event) => events.push(event));
    // peers is not an integer
    logCallback(
      4,
      "json-rpc-paseo",
      responseLine({
        jsonrpc: "2.0",
        id: "__dotli_health__:relay:1",
        result: { isSyncing: true, peers: "3" },
      }),
    );
    // result missing (error response)
    logCallback(
      4,
      "json-rpc-paseo",
      responseLine({
        jsonrpc: "2.0",
        id: "__dotli_health__:relay:2",
        error: { code: -32000, message: "nope" },
      }),
    );

    expect(events).toEqual([]);
  });
});
