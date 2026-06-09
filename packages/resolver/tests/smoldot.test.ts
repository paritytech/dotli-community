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

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("@dotli/resolver/smoldot");
  getSmoldot = mod.getSmoldot;
  getRelayChain = mod.getRelayChain;
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
