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
