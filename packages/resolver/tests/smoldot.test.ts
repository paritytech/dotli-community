// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from "vitest";

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

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("@dotli/resolver/smoldot");
  getSmoldot = mod.getSmoldot;
  getRelayChain = mod.getRelayChain;
  onLifecycle = mod.onLifecycle;
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

describe("onLifecycle", () => {
  // Grab the logCallback the module hands to smoldot so tests can feed it
  // synthetic json-rpc log lines.
  async function captureLogCallback(): Promise<
    (level: number, target: string, message: string) => void
  > {
    getSmoldot();
    const { startFromWorker } =
      await import("polkadot-api/smoldot/from-worker");
    const options = vi.mocked(startFromWorker).mock.lastCall?.[1];
    if (options?.logCallback === undefined) {
      throw new Error("logCallback was not passed to startFromWorker");
    }
    return options.logCallback;
  }

  function followEventLine(chain: string, kind: string): string {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "lifecycle_unstable_followEvent",
      params: { subscription: "lf-1", result: { kind } },
    });
    return `chain=${chain} response=${payload}`;
  }

  it("delivers events parsed from the json-rpc log stream", async () => {
    const logCallback = await captureLogCallback();
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    logCallback(
      4,
      "json-rpc-asset-hub-paseo",
      followEventLine("asset-hub-paseo", "firstPeer"),
    );
    logCallback(
      4,
      "json-rpc-asset-hub-paseo",
      followEventLine("asset-hub-paseo", "bootstrapComplete"),
    );

    expect(events).toEqual([
      { chainName: "asset-hub-paseo", kind: "firstPeer" },
      { chainName: "asset-hub-paseo", kind: "bootstrapComplete" },
    ]);
  });

  it("replays earlier events to a late subscriber", async () => {
    const logCallback = await captureLogCallback();
    logCallback(4, "json-rpc-paseo", followEventLine("paseo", "firstPeer"));

    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    expect(events).toEqual([{ chainName: "paseo", kind: "firstPeer" }]);
  });

  it("ignores malformed and non-lifecycle payloads", async () => {
    const logCallback = await captureLogCallback();
    const events: unknown[] = [];
    onLifecycle((event) => events.push(event));

    // Mentions the method but carries no response payload.
    logCallback(4, "json-rpc-paseo", "sent lifecycle_unstable_followEvent");
    // Truncated JSON.
    logCallback(
      4,
      "json-rpc-paseo",
      'response={"method":"lifecycle_unstable_followEvent"',
    );
    // A different method that happens to mention the string.
    logCallback(
      4,
      "json-rpc-paseo",
      followEventLine("paseo", "firstPeer").replace(
        "followEvent",
        "followEvent_other",
      ),
    );
    // A kind outside the union.
    logCallback(4, "json-rpc-paseo", followEventLine("paseo", "somethingElse"));
    // Right payload on a non json-rpc target.
    logCallback(4, "sync-service-paseo", followEventLine("paseo", "firstPeer"));

    expect(events).toEqual([]);
  });

  it("stops delivering after unsubscribe", async () => {
    const logCallback = await captureLogCallback();
    const events: unknown[] = [];
    const unsubscribe = onLifecycle((event) => events.push(event));

    logCallback(4, "json-rpc-paseo", followEventLine("paseo", "firstPeer"));
    unsubscribe();
    logCallback(
      4,
      "json-rpc-paseo",
      followEventLine("paseo", "bootstrapComplete"),
    );

    expect(events).toEqual([{ chainName: "paseo", kind: "firstPeer" }]);
  });
});
