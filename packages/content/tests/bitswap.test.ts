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

  it("As a user, a peer set that does not yet hold the CID still loads the app", async () => {
    // Given the connected peers all answer DONT_HAVE twice before a provider attaches
    const chain = stubChain([
      { code: -32812 },
      { code: -32810 },
      { code: -32810 },
      { hex: "0xabcd" },
    ]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bitswap");

    // When
    const promise = bitswapGet("bafyTest");
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    await expect(promise).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.sent).toBe(4);
  });

  it("As a user, a CID no peer ever holds gives up after the discovery bound rather than the full budget", async () => {
    // Given every peer keeps answering DONT_HAVE
    const chain = stubChain([]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bitswap");

    // When
    const promise = bitswapGet("bafyMissing");
    const settled = expect(promise).rejects.toThrow(
      /provider discovery exhausted after 9 failures/,
    );
    await vi.advanceTimersByTimeAsync(185_000);
    await settled;

    // Then it stopped at the bound, well short of the three-minute budget
    expect(chain.sent).toBe(9);
  }, 30_000);

  it("As a user, a slow start does not spend the discovery allowance before discovery begins", async () => {
    // Given three "no peers at all" answers ahead of the DONT_HAVE run
    const chain = stubChain([
      { code: -32812 },
      { code: -32812 },
      { code: -32812 },
    ]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bitswap");

    // When
    const promise = bitswapGet("bafySlowStart");
    const settled = expect(promise).rejects.toThrow(/discovery exhausted/);
    await vi.advanceTimersByTimeAsync(185_000);
    await settled;

    // Then discovery still got its full nine tries on top of the three, and
    // its backoff restarted at the base delay instead of inheriting the 5s cap
    // the three transient failures had already climbed to
    expect(chain.sent).toBe(12);
    expect(chain.gaps[3]).toBe(500);
    expect(chain.gaps[4]).toBe(1_000);
  }, 30_000);

  it("As a user, a run of DONT_HAVE does not pin the next transient retry at the backoff cap", async () => {
    // Given five discovery failures ahead of a "no peers at all" answer
    const chain = stubChain([
      { code: -32810 },
      { code: -32810 },
      { code: -32810 },
      { code: -32810 },
      { code: -32810 },
      { code: -32812 },
      { code: -32812 },
      { hex: "0x01" },
    ]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bitswap");

    // When
    const promise = bitswapGet("bafyTransientRamp");
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    // Then the transient ramp started at its own base delay rather than
    // inheriting the 5s cap the discovery ramp had already climbed to
    expect(chain.gaps[5]).toBe(500);
    expect(chain.gaps[6]).toBe(1_000);
  }, 30_000);

  it("As an integrator, a malformed CID fails on the first reply", async () => {
    // Given
    const chain = stubChain([{ code: -32602 }]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bitswap");

    // When
    const promise = bitswapGet("not-a-cid");
    const settled = expect(promise).rejects.toThrow(/code=-32602/);
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    await settled;
    expect(chain.sent).toBe(1);
  });

  it("As a user, navigating away stops the fetch mid-call instead of finishing the budget", async () => {
    // Given a chain that never replies, so the call is waiting on the wire
    mocks.createRemoteChainProvider.mockImplementation(() => () => ({
      send: () => undefined,
      disconnect: () => undefined,
    }));
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bitswap");
    const aborter = new AbortController();

    // When
    const promise = bitswapGet("bafyInFlight", aborter.signal);
    const settled = expect(promise).rejects.toThrow(/aborted/);
    aborter.abort();

    // Then it gave up at once rather than after the 60s per-call timeout
    await settled;
  });

  it("As a user, navigating away stops the fetch mid-backoff too", async () => {
    // Given a retry that is sleeping between attempts
    const chain = stubChain([], { code: -32812 });
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bitswap");
    const aborter = new AbortController();

    // When the abort lands during the backoff rather than during a call
    const promise = bitswapGet("bafyBackoff", aborter.signal);
    const settled = expect(promise).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeAbort = chain.sent;
    aborter.abort();
    await settled;
    await vi.advanceTimersByTimeAsync(185_000);

    // Then nothing further was sent
    expect(chain.sent).toBe(sentBeforeAbort);
  }, 30_000);

  it("As a user, a fetch asked for with an already-dead signal never reaches the chain", async () => {
    // Given
    const chain = stubChain([{ hex: "0x01" }]);
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bitswap");
    const aborter = new AbortController();
    aborter.abort();

    // When
    const promise = bitswapGet("bafyDead", aborter.signal);

    // Then
    await expect(promise).rejects.toThrow(/aborted/);
    expect(chain.sent).toBe(0);
  });
});

describe("listenForSandboxBitswap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isRemoteChainSupported.mockReturnValue(true);
    mocks.getBackend.mockReturnValue("smoldot-direct");
    mocks.getActiveServicesConfig.mockReturnValue({
      bulletin: { genesis: "0xbull" },
    });
    mocks.isSandboxOrigin.mockReturnValue(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A stand-in for a sandbox iframe's window, distinguishable by identity. */
  function fakeFrame(): { postMessage: ReturnType<typeof vi.fn> } {
    return { postMessage: vi.fn() };
  }

  function post(
    source: unknown,
    data: unknown,
    origin = "https://a.app.dot.li",
  ) {
    window.dispatchEvent(
      Object.assign(new MessageEvent("message", { data }), {
        source,
        origin,
      }),
    );
  }

  it("As a user, leaving a page stops the fetches that page asked for", async () => {
    // Given a sandbox frame with a fetch in flight
    const chain = stubChain([], { code: -32812 });
    vi.resetModules();
    const { listenForSandboxBitswap } = await import("@dotli/content/bitswap");
    listenForSandboxBitswap();
    const frame = fakeFrame();
    post(frame, { type: "dotli:bitswap-get", id: "req-1", cid: "bafyX" });
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeAbort = chain.sent;

    // When that same frame says it is going away
    post(frame, { type: "dotli:bitswap-abort", ids: ["req-1"] });
    await vi.advanceTimersByTimeAsync(185_000);

    // Then the fetch stopped instead of running out the budget
    expect(chain.sent).toBe(sentBeforeAbort);
  }, 30_000);

  it("As a user, one product cannot cancel another product's fetches", async () => {
    // Given two frames at sandbox origins, which every product runs at, and a
    // fetch belonging to the first
    const chain = stubChain([], { code: -32812 });
    vi.resetModules();
    const { listenForSandboxBitswap } = await import("@dotli/content/bitswap");
    listenForSandboxBitswap();
    const victim = fakeFrame();
    const attacker = fakeFrame();
    post(victim, { type: "dotli:bitswap-get", id: "req-1", cid: "bafyX" });
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeForgery = chain.sent;

    // When a different frame guesses the id and posts an abort for it
    post(attacker, { type: "dotli:bitswap-abort", ids: ["req-1"] });
    await vi.advanceTimersByTimeAsync(20_000);

    // Then the victim's fetch carried on
    expect(chain.sent).toBeGreaterThan(sentBeforeForgery);
  }, 30_000);

  it("As an operator, an abort from outside the sandbox origins is ignored", async () => {
    // Given a fetch in flight
    const chain = stubChain([], { code: -32812 });
    vi.resetModules();
    const { listenForSandboxBitswap } = await import("@dotli/content/bitswap");
    listenForSandboxBitswap();
    const frame = fakeFrame();
    post(frame, { type: "dotli:bitswap-get", id: "req-1", cid: "bafyX" });
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeForgery = chain.sent;

    // When the abort arrives from an origin the host does not trust
    mocks.isSandboxOrigin.mockReturnValue(false);
    post(
      frame,
      { type: "dotli:bitswap-abort", ids: ["req-1"] },
      "https://evil.example",
    );
    await vi.advanceTimersByTimeAsync(20_000);

    // Then it was ignored
    expect(chain.sent).toBeGreaterThan(sentBeforeForgery);
  }, 30_000);

  it("As a user, two frames loading at once do not strand each other's fetches", async () => {
    // Given two frames whose request ids collide, which they can because ids
    // restart at 1 in every frame
    const chain = stubChain([{ hex: "0x01" }], { code: -32812 });
    vi.resetModules();
    const { listenForSandboxBitswap } = await import("@dotli/content/bitswap");
    listenForSandboxBitswap();
    const first = fakeFrame();
    const second = fakeFrame();
    post(first, { type: "dotli:bitswap-get", id: "req-1", cid: "bafyFast" });
    post(second, { type: "dotli:bitswap-get", id: "req-1", cid: "bafySlow" });
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeAbort = chain.sent;

    // When the second frame cancels, after the first has already settled
    post(second, { type: "dotli:bitswap-abort", ids: ["req-1"] });
    await vi.advanceTimersByTimeAsync(185_000);

    // Then its fetch stopped, rather than having been orphaned by the first
    // fetch's cleanup deleting the entry out from under it
    expect(chain.sent).toBe(sentBeforeAbort);
  }, 30_000);

  it("As a user, a long-lived subscription does not accumulate abort listeners", async () => {
    // Given a chain that never answers, so every attempt ends on its per-call
    // timeout, and a signal that outlives the call as a subscription's does
    mocks.createRemoteChainProvider.mockImplementation(() => () => ({
      send: () => undefined,
      disconnect: () => undefined,
    }));
    vi.resetModules();
    const { bitswapGet } = await import("@dotli/content/bitswap");
    const aborter = new AbortController();
    let added = 0;
    let removed = 0;
    const add = aborter.signal.addEventListener.bind(aborter.signal);
    const remove = aborter.signal.removeEventListener.bind(aborter.signal);
    aborter.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "abort") added += 1;
      return add(type, ...(rest as [EventListener]));
    }) as typeof add;
    aborter.signal.removeEventListener = ((
      type: string,
      ...rest: unknown[]
    ) => {
      if (type === "abort") removed += 1;
      return remove(type, ...(rest as [EventListener]));
    }) as typeof remove;

    // When the call spends its whole budget on per-call timeouts
    const promise = bitswapGet("bafyLeak", aborter.signal).catch(() => "done");
    await vi.advanceTimersByTimeAsync(185_000);
    await promise;

    // Then every listener it registered came off again
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  }, 30_000);
});
