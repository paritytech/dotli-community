import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRemoteChainProvider: vi.fn(),
  isRemoteChainSupported: vi.fn(() => true),
  getBackend: vi.fn(() => "smoldot-direct"),
  getActiveServicesConfig: vi.fn(() => ({ bulletin: { genesis: "0xbull" } })),
  isSandboxOrigin: vi.fn(() => true),
}));

vi.mock("@dotli/protocol/client", () => ({
  createRemoteChainProvider: mocks.createRemoteChainProvider,
  isRemoteChainSupported: mocks.isRemoteChainSupported,
}));
vi.mock("@dotli/config/mode", () => ({ getBackend: mocks.getBackend }));
vi.mock("@dotli/config/network", () => ({
  getActiveServicesConfig: mocks.getActiveServicesConfig,
}));
vi.mock("@dotli/config/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dotli/config/config")>()),
  isSandboxOrigin: mocks.isSandboxOrigin,
}));

/**
 * Stands in for the protocol iframe's smoldot.
 *
 * `replies` is consumed one entry per `bitswap_v1_get`, so the test spells out
 * the exact sequence the chain hands back across retries.
 */
function stubChain(replies: ({ code: number } | { hex: string })[]): {
  sent: number;
} {
  const state = { sent: 0 };
  mocks.createRemoteChainProvider.mockImplementation(
    () => (onMessage: (m: unknown) => void) => ({
      send: (request: { id: number }) => {
        const reply = replies[state.sent] ?? { code: -32810 };
        state.sent += 1;
        queueMicrotask(() => {
          onMessage(
            "hex" in reply
              ? { jsonrpc: "2.0", id: request.id, result: reply.hex }
              : {
                  jsonrpc: "2.0",
                  id: request.id,
                  error: { code: reply.code, message: "stub" },
                },
          );
        });
      },
      disconnect: () => undefined,
    }),
  );
  return state;
}

describe("bitswapGet retry policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isRemoteChainSupported.mockReturnValue(true);
    mocks.getActiveServicesConfig.mockReturnValue({
      bulletin: { genesis: "0xbull" },
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a dot.li user, a peer set that does not yet hold the CID still loads the app", async () => {
    // Given the connected peers all answer DONT_HAVE twice before a provider attaches
    const chain = stubChain([
      { code: -32812 },
      { code: -32810 },
      { code: -32810 },
      { hex: "0xabcd" },
    ]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bulletin-bitswap");

    // When
    const promise = bitswapGet("bafyTest");
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    await expect(promise).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.sent).toBe(4);
  });
});
