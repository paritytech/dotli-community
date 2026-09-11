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
 * `replies` is consumed one entry per `bitswap_v1_get`, so a test spells out
 * the exact sequence the chain hands back across retries.
 */
function stubChain(
  replies: ({ code: number } | { hex: string })[],
  tail?: { code: number },
): {
  sent: number;
  gaps: number[];
} {
  const state = { sent: 0, gaps: [] as number[], last: null as number | null };
  mocks.createRemoteChainProvider.mockImplementation(
    () => (onMessage: (m: unknown) => void) => ({
      send: (request: { id: number }) => {
        const now = Date.now();
        if (state.last !== null) {
          state.gaps.push(now - state.last);
        }
        state.last = now;
        const reply = replies[state.sent] ?? tail ?? { code: -32810 };
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
    const { bitswapGet } = await import("@dotli/ui/bulletin-bitswap");

    // When
    const promise = bitswapGet("bafyTest");
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    await expect(promise).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.sent).toBe(4);
  });

  it("As a dot.li operator, a transient code arriving after the discovery window does not spin the light client", async () => {
    // Given one discovery failure, then a code that never ends the call. The
    // per-call timeout raises -32811 itself, so this needs nothing unusual
    // from smoldot.
    const chain = stubChain([{ code: -32810 }], { code: -32811 });
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/ui/bulletin-bitswap");

    // When the full three-minute budget elapses
    const promise = bitswapGet("bafySpin");
    const settled = expect(promise).rejects.toThrow(/timed out after 180000ms/);
    await vi.advanceTimersByTimeAsync(185_000);
    await settled;

    // Then the retries stayed on their backoff instead of collapsing to zero
    expect(chain.sent).toBeLessThan(50);
  }, 30_000);

  it("As a dot.li user, discovery retries get their own backoff ramp rather than inheriting the attempt counter", async () => {
    // Given three "no peers at all" answers before discovery failures start
    const chain = stubChain([
      { code: -32812 },
      { code: -32812 },
      { code: -32812 },
      { code: -32810 },
      { code: -32810 },
      { hex: "0x01" },
    ]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/ui/bulletin-bitswap");

    // When
    const promise = bitswapGet("bafyRamp");
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    // Then the first discovery retry waits the base delay, not the 5s cap it
    // would inherit from a shared counter
    expect(chain.gaps[3]).toBe(500);
    expect(chain.gaps[4]).toBe(1_000);
  });

  it("As a dot.li user, a CID that is genuinely absent fails inside the discovery window", async () => {
    // Given every attempt reports -32810
    const chain = stubChain([]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/ui/bulletin-bitswap");

    // When
    const promise = bitswapGet("bafyMissing");
    const code = promise.catch(
      (err: unknown) => (err as { code?: number }).code,
    );
    const settled = expect(promise).rejects.toThrow(
      /provider discovery exhausted after \d+ failures over 30000ms/,
    );
    await vi.advanceTimersByTimeAsync(35_000);
    await settled;

    // Then it gave up on the window rather than the total budget, and kept the
    // code so callers can still branch on it
    await expect(code).resolves.toBe(-32810);
    expect(chain.gaps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
  }, 20_000);

  it("As a dot.li integrator, an invalid CID fails on the first attempt", async () => {
    // Given
    const chain = stubChain([{ code: -32602 }]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/ui/bulletin-bitswap");

    // When
    const promise = bitswapGet("not-a-cid");
    const settled = expect(promise).rejects.toThrow(/code=-32602/);
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    await settled;
    expect(chain.sent).toBe(1);
  });
});
