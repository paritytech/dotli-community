import { describe, expect, it, vi } from "vitest";
import { getActiveServicesConfig } from "@dotli/config/network";
import {
  createRpcUpstreamProvider,
  isRpcUpstreamSupported,
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

    expect(isRpcUpstreamSupported(people.genesis)).toBe(true);

    const provider = {};
    mocks.getWsProvider.mockReturnValueOnce(provider);

    expect(createRpcUpstreamProvider(people.genesis)).toBe(provider);
    expect(mocks.getWsProvider).toHaveBeenCalledWith([...people.rpcs], {
      heartbeatTimeout: 120_000,
    });
  });

  it("rejects unknown genesis hashes", () => {
    expect(isRpcUpstreamSupported("0xdeadbeef")).toBe(false);
    expect(createRpcUpstreamProvider("0xdeadbeef")).toBeNull();
  });

  it("keeps Bulletin operational in the protocol runtime", () => {
    // Given
    const bulletin = getActiveServicesConfig().bulletin;
    const provider = {};
    mocks.getWsProvider.mockReturnValueOnce(provider);

    // When
    const upstreamSupported = isRpcUpstreamSupported(bulletin.genesis);
    const upstreamProvider = createRpcUpstreamProvider(bulletin.genesis);

    // Then
    expect(upstreamSupported).toBe(true);
    expect(upstreamProvider).toBe(provider);
  });
});
