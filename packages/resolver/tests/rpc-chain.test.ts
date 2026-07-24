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
  it("As a dotli integrator, the host reserves Bulletin RPC access for the host-owned Rust core", () => {
    // Given
    const bulletin = getActiveServicesConfig().bulletin;
    const provider = {};
    mocks.getWsProvider.mockReturnValueOnce(provider);

    // When
    const productSupported = isRpcChainSupported(bulletin.genesis);
    const productProvider = createRpcChainProvider(bulletin.genesis);
    const coreSupported = isCoreRpcChainSupported(bulletin.genesis);
    const coreProvider = createCoreRpcChainProvider(bulletin.genesis);

    // Then
    expect(productSupported).toBe(false);
    expect(productProvider).toBeNull();
    expect(coreSupported).toBe(true);
    expect(coreProvider).toBe(provider);
  });
});
