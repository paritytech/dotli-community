import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConfigModule from '../../config/src/config.js';
import type * as BitswapModule from '../src/bitswap.js';

const mocks = vi.hoisted(() => ({
  createRemoteChainProvider: vi.fn(),
  isRemoteChainSupported: vi.fn(() => true),
  getBackend: vi.fn(() => 'smoldot-direct'),
  getActiveServicesConfig: vi.fn(() => ({ bulletin: { genesis: '0xbull' } })),
  isSandboxOrigin: vi.fn(() => true),
}));

vi.mock('../../protocol/src/client.js', () => ({
  createRemoteChainProvider: mocks.createRemoteChainProvider,
  isRemoteChainSupported: mocks.isRemoteChainSupported,
}));
vi.mock('../../config/src/mode.js', () => ({ getBackend: mocks.getBackend }));
vi.mock('../../config/src/network.js', () => ({
  getActiveServicesConfig: mocks.getActiveServicesConfig,
}));
vi.mock('../../config/src/config.js', async importOriginal => ({
  ...(await importOriginal<typeof ConfigModule>()),
  isSandboxOrigin: mocks.isSandboxOrigin,
}));

let bitswapGet: typeof BitswapModule.bitswapGet;
let listenForSandboxBitswap: typeof BitswapModule.listenForSandboxBitswap;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.isRemoteChainSupported.mockReturnValue(true);
  mocks.getBackend.mockReturnValue('smoldot-direct');
  mocks.getActiveServicesConfig.mockReturnValue({
    bulletin: { genesis: '0xbull' },
  });
  mocks.isSandboxOrigin.mockReturnValue(true);
  vi.useFakeTimers();
  // Finish loading a fresh module before a test installs its chain fixture.
  // An import inside a timed-out test can resume against the next test's mock.
  // Static imports would share connection and pending-request state across cases.
  vi.resetModules();
  ({ bitswapGet, listenForSandboxBitswap } = await import('../src/bitswap.js'));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Stands in for the protocol iframe's smoldot, answering each `bitswap_v1_get` with the next of `replies`. */
function stubChain(
  replies: ({ code: number } | { hex: string })[],
  tail?: { code: number },
): {
  sent: number;
  gaps: number[];
} {
  const state = { sent: 0, gaps: [] as number[], last: null as number | null };
  mocks.createRemoteChainProvider.mockImplementation(() => (onMessage: (m: unknown) => void) => ({
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
          'hex' in reply
            ? { jsonrpc: '2.0', id: request.id, result: reply.hex }
            : {
                jsonrpc: '2.0',
                id: request.id,
                error: { code: reply.code, message: 'stub' },
              },
        );
      });
    },
    disconnect: () => undefined,
  }));
  return state;
}

describe('bitswapGet retry policy', () => {
  it('As a user, a peer set that does not yet hold the CID still loads the app', async () => {
    // Given the connected peers all answer DONT_HAVE twice before a provider attaches
    const chain = stubChain([{ code: -32812 }, { code: -32810 }, { code: -32810 }, { hex: '0xabcd' }]);

    // When
    const promise = bitswapGet('bafyTest');
    const settled = expect(promise).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    await settled;
    expect(chain.sent).toBe(4);
  });

  it('As a user, a CID no peer ever holds gives up after the discovery bound rather than the full budget', async () => {
    // Given every peer keeps answering DONT_HAVE
    const chain = stubChain([]);

    // When
    const promise = bitswapGet('bafyMissing');
    const settled = expect(promise).rejects.toThrow(/provider discovery exhausted after 9 failures/);
    await vi.advanceTimersByTimeAsync(185_000);
    await settled;

    // Then it stopped at the bound, well short of the three-minute budget
    expect(chain.sent).toBe(9);
  }, 30_000);

  it('As a user, a slow start does not spend the discovery allowance before discovery begins', async () => {
    // Given three "no peers at all" answers ahead of the DONT_HAVE run
    const chain = stubChain([{ code: -32812 }, { code: -32812 }, { code: -32812 }]);

    // When
    const promise = bitswapGet('bafySlowStart');
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

  it('As a user, a run of DONT_HAVE does not pin the next transient retry at the backoff cap', async () => {
    // Given five discovery failures ahead of a "no peers at all" answer
    const chain = stubChain([
      { code: -32810 },
      { code: -32810 },
      { code: -32810 },
      { code: -32810 },
      { code: -32810 },
      { code: -32812 },
      { code: -32812 },
      { hex: '0x01' },
    ]);

    // When
    const promise = bitswapGet('bafyTransientRamp');
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    // Then the transient ramp started at its own base delay rather than
    // inheriting the 5s cap the discovery ramp had already climbed to
    expect(chain.gaps[5]).toBe(500);
    expect(chain.gaps[6]).toBe(1_000);
  }, 30_000);

  it('As an integrator, a malformed CID fails on the first reply', async () => {
    // Given
    const chain = stubChain([{ code: -32602 }]);

    // When
    const promise = bitswapGet('not-a-cid');
    const settled = expect(promise).rejects.toThrow(/code=-32602/);
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    await settled;
    expect(chain.sent).toBe(1);
  });

  it('As a user, navigating away stops the fetch mid-call instead of finishing the budget', async () => {
    // Given a chain that never replies, so the call is waiting on the wire
    mocks.createRemoteChainProvider.mockImplementation(() => () => ({
      send: () => undefined,
      disconnect: () => undefined,
    }));
    const aborter = new AbortController();

    // When
    const promise = bitswapGet('bafyInFlight', aborter.signal);
    const settled = expect(promise).rejects.toThrow(/aborted/);
    aborter.abort();

    // Then it gave up at once rather than after the 60s per-call timeout
    await settled;
  });

  it('As a user, navigating away stops the fetch mid-backoff too', async () => {
    // Given a retry that is sleeping between attempts
    const chain = stubChain([], { code: -32812 });
    const aborter = new AbortController();

    // When the abort lands during the backoff rather than during a call
    const promise = bitswapGet('bafyBackoff', aborter.signal);
    const settled = expect(promise).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeAbort = chain.sent;
    aborter.abort();
    await settled;
    await vi.advanceTimersByTimeAsync(185_000);

    // Then nothing further was sent
    expect(chain.sent).toBe(sentBeforeAbort);
  }, 30_000);

  it('As a user, a fetch asked for with an already-dead signal never reaches the chain', async () => {
    // Given
    const chain = stubChain([{ hex: '0x01' }]);
    const aborter = new AbortController();
    aborter.abort();

    // When
    const promise = bitswapGet('bafyDead', aborter.signal);

    // Then
    await expect(promise).rejects.toThrow(/aborted/);
    expect(chain.sent).toBe(0);
  });
});

describe('bitswapGet after a halt', () => {
  interface HaltableChain {
    /** Each dial's message and halt callbacks, in dial order. */
    dialled: { onMessage: (m: unknown) => void; onHalt: (reason: 'chain' | 'frame') => void }[];
    /** The ids sent on the first connection, which never replies. */
    unanswered: number[];
  }

  /** One fake connection per dial. The first never replies, later ones answer. */
  function stubHaltableChain(): HaltableChain {
    const chain: HaltableChain = { dialled: [], unanswered: [] };
    mocks.createRemoteChainProvider.mockImplementation(
      () => (onMessage: (m: unknown) => void, onHalt?: (reason: 'chain' | 'frame') => void) => {
        const first = chain.dialled.length === 0;
        if (onHalt !== undefined) {
          chain.dialled.push({ onMessage, onHalt });
        }
        return {
          send: (request: { id: number }) => {
            if (first) {
              chain.unanswered.push(request.id);
              return;
            }
            queueMicrotask(() => {
              onMessage({ jsonrpc: '2.0', id: request.id, result: '0xabcd' });
            });
          },
          disconnect: () => undefined,
        };
      },
    );
    return chain;
  }

  function dialled(chain: HaltableChain, index: number): HaltableChain['dialled'][number] {
    const connection = chain.dialled[index];
    if (connection === undefined) {
      throw new Error(`no connection ${String(index)}`);
    }
    return connection;
  }

  it('As a dotli user, content still loads after the Bulletin chain halts', async () => {
    // Given a request in flight on a connection that then halts
    const chain = stubHaltableChain();
    const { log } = await import('@dotli/shared');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const inFlight = bitswapGet('bafyHalt');
    await vi.advanceTimersByTimeAsync(100);

    // When the chain halts the way the pool halts it: the request in flight
    // is answered with the halt first, and the connection hears it after
    const halted = dialled(chain, 0);
    halted.onMessage({
      jsonrpc: '2.0',
      id: chain.unanswered[0],
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    halted.onHalt('chain');
    await vi.advanceTimersByTimeAsync(1_000);

    // Then the same call redials and resolves with the second connection's bytes
    await expect(inFlight).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.dialled).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[dot.li bitswap] bafyHalt retry attempt=1 code=-32811 delay=500ms');
  });

  it('As a dotli user, a request in flight when the protocol frame dies fails at once', async () => {
    // Given a request in flight on a connection that never replies
    const chain = stubHaltableChain();
    const inFlight = bitswapGet('bafyFrame');
    const settled = expect(inFlight).rejects.toThrow('Bulletin connection halted');
    await vi.advanceTimersByTimeAsync(100);

    // When the frame dies
    dialled(chain, 0).onHalt('frame');

    // Then it fails without waiting for the 60s per-call timeout, and
    // nothing dials during that call
    await settled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chain.dialled).toHaveLength(1);

    // And a later fetch dials anew
    const next = bitswapGet('bafyFrame');
    await vi.advanceTimersByTimeAsync(100);
    await expect(next).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.dialled).toHaveLength(2);
  });

  interface ManualDial {
    onMessage: (m: unknown) => void;
    onHalt: (reason: 'chain' | 'frame') => void;
    /** The ids sent on this connection, in order. Nothing is answered unasked. */
    sent: number[];
  }

  /** One fake connection per dial, each answered only by the test. */
  function stubManualChain(): ManualDial[] {
    const dials: ManualDial[] = [];
    mocks.createRemoteChainProvider.mockImplementation(
      () => (onMessage: (m: unknown) => void, onHalt?: (reason: 'chain' | 'frame') => void) => {
        const dial: ManualDial = { onMessage, onHalt: onHalt ?? (() => undefined), sent: [] };
        dials.push(dial);
        return {
          send: (request: { id: number }) => {
            dial.sent.push(request.id);
          },
          disconnect: () => undefined,
        };
      },
    );
    return dials;
  }

  function manualDial(dials: ManualDial[], index: number): ManualDial {
    const dial = dials[index];
    if (dial === undefined) {
      throw new Error(`no connection ${String(index)}`);
    }
    return dial;
  }

  it('As a dotli user, a fetch after a connection that never opened dials again', async () => {
    // Given a fetch on a connection the protocol frame never opened, closed the
    // way the client closes it: the queued request answered, then a dead frame
    const dials = stubManualChain();
    const failed = bitswapGet('bafyNoFrame');
    const settled = expect(failed).rejects.toThrow('Chain connection is closed');
    await vi.advanceTimersByTimeAsync(100);
    const dead = manualDial(dials, 0);
    dead.onMessage({
      jsonrpc: '2.0',
      id: dead.sent[0],
      error: { code: -32603, message: 'Chain connection is closed' },
    });
    dead.onHalt('frame');
    await settled;

    // When
    const next = bitswapGet('bafyNoFrame');
    await vi.advanceTimersByTimeAsync(100);
    const redialled = manualDial(dials, 1);
    redialled.onMessage({ jsonrpc: '2.0', id: redialled.sent[0], result: '0xabcd' });

    // Then
    await expect(next).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(dials).toHaveLength(2);
    expect(dead.sent).toHaveLength(1);
  });

  it('As a dotli user, a late halt from a replaced Bulletin connection leaves the new one working', async () => {
    // Given a fetch that redialled after its chain halted, with a request in
    // flight on the new connection
    const dials = stubManualChain();
    const { log } = await import('@dotli/shared');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const fetching = bitswapGet('bafyReplaced');
    let settled = false;
    void fetching.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    const replaced = manualDial(dials, 0);
    replaced.onMessage({
      jsonrpc: '2.0',
      id: replaced.sent[0],
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    replaced.onHalt('chain');
    await vi.advanceTimersByTimeAsync(1_000);
    const current = manualDial(dials, 1);
    expect(current.sent).toHaveLength(1);

    // When the replaced connection hears a halt again
    replaced.onHalt('frame');
    await vi.advanceTimersByTimeAsync(100);

    // Then the request on the new connection is still pending, and is served there
    expect(settled).toBe(false);
    current.onMessage({ jsonrpc: '2.0', id: current.sent[0], result: '0xabcd' });
    await expect(fetching).resolves.toEqual(new Uint8Array([0xab, 0xcd]));

    // And the next fetch uses the new connection without dialling
    const next = bitswapGet('bafyReplaced');
    await vi.advanceTimersByTimeAsync(100);
    current.onMessage({ jsonrpc: '2.0', id: current.sent[1], result: '0xef' });
    await expect(next).resolves.toEqual(new Uint8Array([0xef]));
    expect(dials).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[dot.li bitswap] bafyReplaced retry attempt=1 code=-32811 delay=500ms');
  });
});

describe('listenForSandboxBitswap', () => {
  /** A stand-in for a sandbox iframe's window, distinguishable by identity. */
  function fakeFrame(): { postMessage: ReturnType<typeof vi.fn> } {
    return { postMessage: vi.fn() };
  }

  function post(source: unknown, data: unknown, origin = 'https://a.app.dot.li'): void {
    window.dispatchEvent(
      Object.assign(new MessageEvent('message', { data }), {
        source,
        origin,
      }),
    );
  }

  it('As a user, leaving a page stops the fetches that page asked for', async () => {
    // Given a sandbox frame with a fetch in flight
    const chain = stubChain([], { code: -32812 });
    listenForSandboxBitswap();
    const frame = fakeFrame();
    post(frame, { type: 'dotli:bitswap-get', id: 'req-1', cid: 'bafyX' });
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeAbort = chain.sent;

    // When that same frame says it is going away
    post(frame, { type: 'dotli:bitswap-abort', ids: ['req-1'] });
    await vi.advanceTimersByTimeAsync(185_000);

    // Then the fetch stopped instead of running out the budget
    expect(chain.sent).toBe(sentBeforeAbort);
  }, 30_000);

  it("As a user, one product cannot cancel another product's fetches", async () => {
    // Given two frames at sandbox origins, which every product runs at, and a
    // fetch belonging to the first
    const chain = stubChain([], { code: -32812 });
    listenForSandboxBitswap();
    const victim = fakeFrame();
    const attacker = fakeFrame();
    post(victim, { type: 'dotli:bitswap-get', id: 'req-1', cid: 'bafyX' });
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeForgery = chain.sent;

    // When a different frame guesses the id and posts an abort for it
    post(attacker, { type: 'dotli:bitswap-abort', ids: ['req-1'] });
    await vi.advanceTimersByTimeAsync(20_000);

    // Then the victim's fetch carried on
    expect(chain.sent).toBeGreaterThan(sentBeforeForgery);
  }, 30_000);

  it('As an operator, an abort from outside the sandbox origins is ignored', async () => {
    // Given a fetch in flight
    const chain = stubChain([], { code: -32812 });
    listenForSandboxBitswap();
    const frame = fakeFrame();
    post(frame, { type: 'dotli:bitswap-get', id: 'req-1', cid: 'bafyX' });
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeForgery = chain.sent;

    // When the abort arrives from an origin the host does not trust
    mocks.isSandboxOrigin.mockReturnValue(false);
    post(frame, { type: 'dotli:bitswap-abort', ids: ['req-1'] }, 'https://evil.example');
    await vi.advanceTimersByTimeAsync(20_000);

    // Then it was ignored
    expect(chain.sent).toBeGreaterThan(sentBeforeForgery);
  }, 30_000);

  it('As an operator, a failed fetch reaches the sandbox with its error class and code', async () => {
    // Given a chain that rejects the request outright
    stubChain([{ code: -32602 }]);
    listenForSandboxBitswap();
    const frame = fakeFrame();

    // When a sandbox asks for the block
    post(frame, { type: 'dotli:bitswap-get', id: 'req-1', cid: 'bafyX' });
    await vi.advanceTimersByTimeAsync(100);

    // Then the reply says what kind of failure it was, not only its text
    expect(frame.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'dotli:bitswap-result',
        id: 'req-1',
        ok: false,
        errorName: 'BitswapRpcError',
        code: -32602,
      }),
      expect.anything(),
    );
  });

  it("As a user, two frames loading at once do not strand each other's fetches", async () => {
    // Given two frames whose request ids collide, which they can because ids
    // restart at 1 in every frame
    const chain = stubChain([{ hex: '0x01' }], { code: -32812 });
    listenForSandboxBitswap();
    const first = fakeFrame();
    const second = fakeFrame();
    post(first, { type: 'dotli:bitswap-get', id: 'req-1', cid: 'bafyFast' });
    post(second, { type: 'dotli:bitswap-get', id: 'req-1', cid: 'bafySlow' });
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeAbort = chain.sent;

    // When the second frame cancels, after the first has already settled
    post(second, { type: 'dotli:bitswap-abort', ids: ['req-1'] });
    await vi.advanceTimersByTimeAsync(185_000);

    // Then its fetch stopped, rather than having been orphaned by the first
    // fetch's cleanup deleting the entry out from under it
    expect(chain.sent).toBe(sentBeforeAbort);
  }, 30_000);

  it('As a user, a long-lived subscription does not accumulate abort listeners', async () => {
    // Given a chain that never answers, so every attempt ends on its per-call
    // timeout, and a signal that outlives the call as a subscription's does
    mocks.createRemoteChainProvider.mockImplementation(() => () => ({
      send: () => undefined,
      disconnect: () => undefined,
    }));
    const aborter = new AbortController();
    let added = 0;
    let removed = 0;
    const add = aborter.signal.addEventListener.bind(aborter.signal);
    const remove = aborter.signal.removeEventListener.bind(aborter.signal);
    aborter.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') {
        added += 1;
      }
      add(type, ...(rest as [EventListener]));
    }) as typeof add;
    aborter.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') {
        removed += 1;
      }
      remove(type, ...(rest as [EventListener]));
    }) as typeof remove;

    // When the call spends its whole budget on per-call timeouts
    const promise = bitswapGet('bafyLeak', aborter.signal).catch(() => 'done');
    await vi.advanceTimersByTimeAsync(185_000);
    await promise;

    // Then every listener it registered came off again
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  }, 30_000);
});
