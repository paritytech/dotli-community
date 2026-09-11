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
 * Stands in for the protocol iframe's smoldot. `replies` is consumed one entry
 * per `bitswap_v1_get`, so a test spells out the exact sequence the chain hands
 * back across retries. Running off the end repeats -32810, which is the
 * "this CID is nowhere" case.
 */
function stubChain(replies: ({ code: number } | { hex: string })[]): {
  sent: number;
  gaps: number[];
} {
  const state = { sent: 0, gaps: [], last: null as number | null };
  mocks.createRemoteChainProvider.mockImplementation(
    () => (onMessage: (m: unknown) => void) => ({
      send: (request: { id: number }) => {
        const now = Date.now();
        if (state.last !== null) state.gaps.push(now - state.last);
        state.last = now;
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

async function freshModule(): Promise<
  typeof import("@dotli/ui/bulletin-bitswap")
> {
  vi.resetModules();
  return import("@dotli/ui/bulletin-bitswap");
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
    const { bitswapGet } = await freshModule();

    // When
    const promise = bitswapGet("bafyTest");
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    await expect(promise).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.sent).toBe(4);
  });

  it("As a dot.li user, discovery retries get a full backoff ramp even after a -32812 burned the attempt counter", async () => {
    // Given three "no peers at all" answers before discovery failures start
    const chain = stubChain([
      { code: -32812 },
      { code: -32812 },
      { code: -32812 },
      { code: -32810 },
      { code: -32810 },
      { hex: "0x01" },
    ]);
    const { bitswapGet } = await freshModule();

    // When
    const promise = bitswapGet("bafyRamp");
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    // Then the first discovery retry waits the base delay, not the 5s cap it
    // would inherit from `attempt`
    expect(chain.gaps[3]).toBe(500);
    expect(chain.gaps[4]).toBe(1_000);
  });

  it("As a dot.li user, a CID that is genuinely absent fails inside the discovery window", async () => {
    // Given every attempt reports -32810
    stubChain([]);
    const { bitswapGet } = await freshModule();

    // When
    const promise = bitswapGet("bafyMissing");
    const settled = expect(promise).rejects.toThrow(
      /provider discovery exhausted after \d+ failures over 30000ms \(\d+ total attempts\)/,
    );
    await vi.advanceTimersByTimeAsync(35_000);

    // Then
    await settled;
  }, 20_000);

  it("As a dot.li operator, the exhausted error still carries the -32810 code for callers that branch on it", async () => {
    // Given
    stubChain([]);
    const { bitswapGet } = await freshModule();

    // When
    const code = bitswapGet("bafyMissing")
      .then(() => null)
      .catch((err: unknown) => (err as { code?: number }).code);
    await vi.advanceTimersByTimeAsync(35_000);

    // Then
    await expect(code).resolves.toBe(-32810);
  }, 20_000);

  it("As a dot.li user, no retry sleeps past the deadline it is about to be judged against", async () => {
    // Given a run that reaches the 5s backoff cap well inside the window
    const chain = stubChain([]);
    const { bitswapGet } = await freshModule();

    // When
    const promise = bitswapGet("bafyMissing");
    const settled = expect(promise).rejects.toThrow(/discovery exhausted/);
    await vi.advanceTimersByTimeAsync(35_000);
    await settled;

    // Then every gap between attempts fits inside the 30s window, so the last
    // attempt lands on the boundary rather than 5s past it
    const total = chain.gaps.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(30_000);
  }, 20_000);

  it("As a dot.li integrator, an invalid CID fails on the first attempt", async () => {
    // Given
    const chain = stubChain([{ code: -32602 }]);
    const { bitswapGet } = await freshModule();

    // When
    const promise = bitswapGet("not-a-cid");
    const settled = expect(promise).rejects.toThrow(/code=-32602/);
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    await settled;
    expect(chain.sent).toBe(1);
  });

  it("As a dot.li user, each CID in an archive gets its own discovery window", async () => {
    // Given two concurrent fetches, one recovering late and one immediately
    const replies = new Map([
      ["bafySlow", [{ code: -32810 }, { code: -32810 }, { hex: "0x0a" }]],
      ["bafyFast", [{ hex: "0x0b" }]],
    ]);
    const seen = new Map<string, number>();
    mocks.createRemoteChainProvider.mockImplementation(
      () => (onMessage: (m: unknown) => void) => ({
        send: (request: { id: number; params: string[] }) => {
          const cid = request.params[0];
          const n = seen.get(cid) ?? 0;
          seen.set(cid, n + 1);
          const reply = replies.get(cid)?.[n] ?? { code: -32810 };
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
    const { bitswapGet } = await freshModule();

    // When
    const both = Promise.all([bitswapGet("bafySlow"), bitswapGet("bafyFast")]);
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    await expect(both).resolves.toEqual([
      new Uint8Array([0x0a]),
      new Uint8Array([0x0b]),
    ]);
  });
});
