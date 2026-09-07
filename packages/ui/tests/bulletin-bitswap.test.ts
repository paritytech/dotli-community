import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onMessage: undefined as ((message: unknown) => void) | undefined,
  send: vi.fn(),
}));

vi.mock("@dotli/protocol/client", () => ({
  createRemoteChainProvider: () => (onMessage: (message: unknown) => void) => {
    mocks.onMessage = onMessage;
    return {
      send: mocks.send,
      disconnect: vi.fn(),
    };
  },
  isRemoteChainSupported: () => true,
}));

vi.mock("@dotli/config/network", () => ({
  getActiveServicesConfig: () => ({ bulletin: { genesis: "0xbulletin" } }),
}));

vi.mock("@dotli/config/mode", () => ({
  getBackend: () => "smoldot-direct",
}));

vi.mock("@dotli/config/config", () => ({
  isSandboxOrigin: () => true,
}));

vi.mock("@dotli/shared/log", () => ({
  log: { warn: vi.fn() },
}));

import { bitswapGet } from "@dotli/ui/bulletin-bitswap";

describe("Bulletin bitswap cold start", () => {
  it("recovers when the first request races peer discovery", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      mocks.send.mockImplementation((request: { id?: number }) => {
        attempt += 1;
        const id = request.id;
        queueMicrotask(() => {
          if (attempt === 1) {
            mocks.onMessage?.({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32810,
                message: "No connected peers have the CID requested.",
              },
            });
          } else {
            mocks.onMessage?.({ jsonrpc: "2.0", id, result: "0x0102" });
          }
        });
      });

      const fetched = bitswapGet("bafy-cold-start");
      await vi.advanceTimersByTimeAsync(500);

      await expect(fetched).resolves.toEqual(new Uint8Array([1, 2]));
      expect(mocks.send).toHaveBeenCalledTimes(2);

      mocks.send.mockImplementation((request: { id?: number }) => {
        const id = request.id;
        queueMicrotask(() => {
          mocks.onMessage?.({
            jsonrpc: "2.0",
            id,
            error: { code: -32810, message: "content missing" },
          });
        });
      });

      await expect(bitswapGet("bafy-genuinely-missing")).rejects.toThrow(
        /content missing/,
      );
      expect(mocks.send).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
