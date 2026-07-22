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
