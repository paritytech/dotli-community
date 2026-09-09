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

describe("Bulletin bitswap provider discovery", () => {
  it("recovers when the first request races peer discovery", async () => {
    vi.useFakeTimers();
    mocks.send.mockReset();
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a child CID after the root CID succeeded", async () => {
    vi.useFakeTimers();
    mocks.send.mockReset();
    try {
      let childAttempts = 0;
      mocks.send.mockImplementation(
        (request: { id?: number; params?: string[] }) => {
          const id = request.id;
          const cid = request.params?.[0];
          queueMicrotask(() => {
            if (cid === "bafy-root") {
              mocks.onMessage?.({ jsonrpc: "2.0", id, result: "0x01" });
              return;
            }
            childAttempts += 1;
            if (childAttempts === 1) {
              mocks.onMessage?.({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32810,
                  message: "No connected peers have the CID requested.",
                },
              });
            } else {
              mocks.onMessage?.({ jsonrpc: "2.0", id, result: "0x02" });
            }
          });
        },
      );

      await expect(bitswapGet("bafy-root")).resolves.toEqual(
        new Uint8Array([1]),
      );

      const fetchedChild = bitswapGet("bafy-child");
      await vi.advanceTimersByTimeAsync(500);

      await expect(fetchedChild).resolves.toEqual(new Uint8Array([2]));
      expect(mocks.send).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying a missing CID after the discovery bound", async () => {
    vi.useFakeTimers();
    mocks.send.mockReset();
    try {
      mocks.send.mockImplementation((request: { id?: number }) => {
        const id = request.id;
        queueMicrotask(() => {
          mocks.onMessage?.({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32810,
              message: "No connected peers have the CID requested.",
            },
          });
        });
      });

      const fetched = bitswapGet("bafy-missing");
      const outcome = fetched.then(
        () => new Error("expected missing CID to fail"),
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(12_500);

      const err = await outcome;
      if (!(err instanceof Error)) {
        throw new Error("expected missing CID error");
      }
      expect(err.message).toMatch(
        /bafy-missing.*provider discovery exhausted after 6 attempts/,
      );
      expect(mocks.send).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
