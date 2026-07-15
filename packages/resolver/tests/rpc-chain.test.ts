import { describe, expect, it, vi } from "vitest";
import { getActiveServicesConfig } from "@dotli/config/network";
import {
  createCoreRpcChainProvider,
  createRpcChainProvider,
  isCoreRpcChainSupported,
  isRpcChainSupported,
} from "@dotli/resolver/rpc-chain";

const mocks = vi.hoisted(() => ({
  getWsProvider: vi.fn(),
}));

vi.mock("polkadot-api/ws", () => ({
  getWsProvider: mocks.getWsProvider,
}));

describe("rpc-chain", () => {
  it("supports the active People chain when RPC endpoints are configured", () => {
    const people = getActiveServicesConfig().people;

    expect(isRpcChainSupported(people.genesis)).toBe(true);

    const provider = {};
    mocks.getWsProvider.mockReturnValueOnce(provider);

    expect(createRpcChainProvider(people.genesis)).toBe(provider);
    expect(mocks.getWsProvider).toHaveBeenCalledWith([...people.rpcs], {
      heartbeatTimeout: 120_000,
    });
  });

  it("rejects unknown genesis hashes", () => {
    expect(isRpcChainSupported("0xdeadbeef")).toBe(false);
    expect(createRpcChainProvider("0xdeadbeef")).toBeNull();
  });

  it("reserves Bulletin RPC access for the host-owned Rust core", () => {
    const bulletin = getActiveServicesConfig().bulletin;
    expect(isRpcChainSupported(bulletin.genesis)).toBe(false);
    expect(createRpcChainProvider(bulletin.genesis)).toBeNull();

    const provider = {};
    mocks.getWsProvider.mockReturnValueOnce(provider);
    expect(isCoreRpcChainSupported(bulletin.genesis)).toBe(true);
    expect(createCoreRpcChainProvider(bulletin.genesis)).toBe(provider);
  });
});
