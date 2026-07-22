import { beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveServicesConfig } from "@dotli/config/network";
import { createChainConnect } from "@dotli/ui/host-callbacks/Chain";

const mocks = vi.hoisted(() => ({
  connectChain: vi.fn(),
}));

vi.mock("@dotli/protocol/client", () => ({
  connectChain: mocks.connectChain,
}));

function hexBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

describe("createChainConnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes the Rust Core callback through the protocol connection", async () => {
    const genesisHash = getActiveServicesConfig().assethub.genesis;
    const connection = {
      send: vi.fn(),
      responses: vi.fn(),
      close: vi.fn(),
    };
    mocks.connectChain.mockResolvedValue(connection);

    const result = await createChainConnect()(hexBytes(genesisHash));

    expect(mocks.connectChain).toHaveBeenCalledWith(genesisHash);
    expect(result).toBe(connection);
  });

  it("propagates protocol connection failures", async () => {
    const genesisHash = getActiveServicesConfig().bulletin.genesis;
    const error = new Error("Unsupported chain");
    mocks.connectChain.mockRejectedValue(error);

    await expect(createChainConnect()(hexBytes(genesisHash))).rejects.toBe(
      error,
    );
  });
});
