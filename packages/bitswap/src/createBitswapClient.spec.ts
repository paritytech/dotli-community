// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { createManualTimers, type ManualTimers } from '@dotli/shared/testing';
import type { JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { createBitswapClient, type BitswapClient } from './createBitswapClient.js';

/** The client's clock, which each test moves itself. */
let timers: ManualTimers;

beforeEach(() => {
  timers = createManualTimers();
});

type Reply = { code: number; data?: string } | { hex: string } | 'silent';

type Dial = {
  onMessage: (message: JsonRpcMessage) => void;
  /** The ids sent on this connection, in order. */
  sent: number[];
  /** How many times the client disconnected this connection. */
  disconnected: number;
};

type FakeChainOptions = {
  /** The reply once `replies` ran out. A DONT_HAVE by default. */
  tail?: Reply;
  /** The dials, by index, whose `disconnect` throws. */
  throwingDisconnects?: number[];
};

/**
 * Stands in for the caller's Bulletin connection. Each `bitswap_v1_get` is answered with the next of `replies`,
 * then with `tail`, unless the reply is `silent`. Every dial opens a new connection.
 */
function createFakeChain(
  replies: Reply[] = [],
  { tail = { code: -32810 }, throwingDisconnects = [] }: FakeChainOptions = {},
) {
  const dials: Dial[] = [];
  const gaps: number[] = [];
  let answered = 0;
  let last: number | null = null;
  const provider: JsonRpcProvider = onMessage => {
    const dial: Dial = { onMessage, sent: [], disconnected: 0 };
    const throwsOnDisconnect = throwingDisconnects.includes(dials.length);
    dials.push(dial);
    return {
      send: request => {
        // The client gives every request a numeric id, which the request type leaves open.
        const id = (request as { id: number }).id;
        dial.sent.push(id);
        const now = timers.now();
        if (last !== null) {
          gaps.push(now - last);
        }
        last = now;
        const reply = replies[answered] ?? tail;
        answered += 1;
        if (reply === 'silent') {
          return;
        }
        queueMicrotask(() => {
          onMessage(
            'hex' in reply
              ? { jsonrpc: '2.0', id, result: reply.hex }
              : { jsonrpc: '2.0', id, error: { code: reply.code, message: 'stub', data: reply.data } },
          );
        });
      },
      disconnect: () => {
        dial.disconnected += 1;
        if (throwsOnDisconnect) {
          throw new Error('Bulletin connection would not close');
        }
      },
    };
  };
  return {
    provider,
    /** Every connection the client opened, in order. */
    dials,
    /** The requests sent across all connections. */
    sent: () => dials.reduce((sum, dial) => sum + dial.sent.length, 0),
    /** The time between each request and the one before it, across connections. */
    gaps,
  };
}

function getDial(dials: Dial[], index: number): Dial {
  const dial = dials[index];
  if (dial === undefined) {
    throw new Error(`no connection ${String(index)}`);
  }
  return dial;
}

function getSentId(dial: Dial, index: number): number {
  const id = dial.sent[index];
  if (id === undefined) {
    throw new Error(`no request ${String(index)}`);
  }
  return id;
}

function createClient(provider: JsonRpcProvider | null): BitswapClient {
  return createBitswapClient({ provider: () => provider, timers });
}

/** A signal that never aborts and counts the abort listeners attached to it, so a leak shows as a number. */
class CountingSignal extends EventTarget {
  readonly aborted = false;
  readonly reason: unknown = undefined;
  added = 0;
  live = 0;
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    if (args[0] === 'abort') {
      this.added += 1;
      this.live += 1;
    }
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    if (args[0] === 'abort') {
      this.live -= 1;
    }
    super.removeEventListener(...args);
  }
}

describe('createBitswapClient retry policy', () => {
  it('As a user, I still load the app when the peer set does not yet hold the CID', async () => {
    // Given the connected peers all answer DONT_HAVE twice before a provider attaches
    const chain = createFakeChain([{ code: -32812 }, { code: -32810 }, { code: -32810 }, { hex: '0xabcd' }]);

    // When
    const block = createClient(chain.provider).get('bafyTest');
    await timers.advance(10_000);

    // Then
    await expect(block).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.sent()).toBe(4);
  });

  it('As a user, I see a CID no peer ever holds give up after the discovery bound rather than the full budget', async () => {
    // Given every peer keeps answering DONT_HAVE
    const chain = createFakeChain();

    // When
    const block = createClient(chain.provider).get('bafyMissing');
    // Marks the rejection handled while the timers advance.
    const settled = Promise.allSettled([block]);
    await timers.advance(185_000);
    await settled;

    // Then it stopped at the bound, well short of the three-minute budget
    await expect(block).rejects.toMatchObject({
      name: 'BitswapNotFoundError',
      // Vitest types the matcher `any`, widened so no `any` reaches the expected object.
      message: expect.stringMatching(/provider discovery exhausted after 9 failures/) as unknown,
    });
    expect(chain.sent()).toBe(9);
  });

  it('As a user, I keep the discovery allowance through a slow start until discovery begins', async () => {
    // Given three "no peers at all" answers ahead of the DONT_HAVE run
    const chain = createFakeChain([{ code: -32812 }, { code: -32812 }, { code: -32812 }]);

    // When
    const block = createClient(chain.provider).get('bafySlowStart');
    // Marks the rejection handled while the timers advance.
    const settled = Promise.allSettled([block]);
    await timers.advance(185_000);
    await settled;

    // Then discovery still got its nine tries on top of the three, and its backoff restarted at the base delay
    await expect(block).rejects.toThrow(/discovery exhausted/);
    expect(chain.sent()).toBe(12);
    expect(chain.gaps[3]).toBe(500);
    expect(chain.gaps[4]).toBe(1_000);
  });

  it('As a user, I see a transient retry after a run of DONT_HAVE start below the backoff cap', async () => {
    // Given five discovery failures ahead of two "no peers at all" answers
    const chain = createFakeChain([
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
    const block = createClient(chain.provider).get('bafyTransientRamp');
    await timers.advance(60_000);
    await block;

    // Then the transient ramp started at its own base delay
    expect(chain.gaps[5]).toBe(500);
    expect(chain.gaps[6]).toBe(1_000);
  });

  it('As an integrator, I see a malformed CID fail on the first reply', async () => {
    // Given
    const chain = createFakeChain([{ code: -32602 }]);

    // When
    const block = createClient(chain.provider).get('not-a-cid');
    // Marks the rejection handled while the timers advance.
    void Promise.allSettled([block]);
    await timers.advance(1_000);

    // Then
    await expect(block).rejects.toMatchObject({ name: 'BitswapRpcError', code: -32602 });
    expect(chain.sent()).toBe(1);
  });

  it('As a user on a network whose frame does not serve Bulletin, I see the fetch fail at once as unavailable', async () => {
    // Given no Bulletin provider in the frame's chain set

    // When
    const block = createClient(null).get('bafyNoBulletin');

    // Then
    await expect(block).rejects.toMatchObject({ name: 'BitswapUnavailableError' });
  });

  it.each([
    [
      'its provider throws when it is called',
      () =>
        createBitswapClient({
          provider: () => {
            throw new Error('Bulletin would not open');
          },
          timers,
        }),
    ],
    [
      'its connection throws when it is dialled',
      () =>
        createBitswapClient({
          provider: () => () => {
            throw new Error('Bulletin would not open');
          },
          timers,
        }),
    ],
  ])('As a user whose Bulletin connection cannot open because %s, I see the fetch fail at once', async (_, build) => {
    // Given a client whose Bulletin connection cannot open
    const client = build();

    // When
    const block = client.get('bafyNoOpen');

    // Then it failed with the error with the timers never moved
    await expect(block).rejects.toThrow('Bulletin would not open');
  });
});

describe('createBitswapClient aborts', () => {
  it('As a user, I navigate away and the fetch stops mid-backoff too', async () => {
    // Given a retry that is waiting between attempts
    const chain = createFakeChain([], { tail: { code: -32812 } });
    const aborter = new AbortController();
    const block = createClient(chain.provider).get('bafyBackoff', aborter.signal);
    // Marks the rejection handled while the timers advance.
    const settled = Promise.allSettled([block]);
    await timers.advance(100);
    const sentBeforeAbort = chain.sent();

    // When the abort lands during the backoff rather than during a call
    aborter.abort();
    await settled;
    await timers.advance(185_000);

    // Then nothing further was sent
    await expect(block).rejects.toThrow(/aborted/);
    expect(chain.sent()).toBe(sentBeforeAbort);
  });

  it('As a user, I ask for a fetch with an already-dead signal and it never reaches the chain', async () => {
    // Given
    const chain = createFakeChain([{ hex: '0x01' }]);
    const aborter = new AbortController();
    aborter.abort();

    // When
    const block = createClient(chain.provider).get('bafyDead', aborter.signal);

    // Then
    await expect(block).rejects.toThrow(/aborted/);
    expect(chain.sent()).toBe(0);
  });

  it('As a user, I give up on a block another part of the page still wants and only my call stops', async () => {
    // Given two callers of one block on a chain that answers only later, the first without a signal
    const chain = createFakeChain(['silent']);
    const client = createClient(chain.provider);
    const aborter = new AbortController();
    const wanted = client.get('bafyWanted');
    const abandoned = client.get('bafyWanted', aborter.signal);
    // Holds the rejection across the timer moves.
    const abandonedOutcome = Promise.allSettled([abandoned]);
    await timers.advance(100);

    // When the second caller gives up, and the chain then answers
    aborter.abort();
    const [abandonedResult] = await abandonedOutcome;
    const dial = getDial(chain.dials, 0);
    dial.onMessage({ jsonrpc: '2.0', id: getSentId(dial, 0), result: '0xabcd' });

    // Then only the second call stopped, and the first got the block from the one request
    expect(abandonedResult).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    await expect(wanted).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.sent()).toBe(1);
  });

  it('As a user, I keep a long-lived subscription and it gathers no abort listeners', async () => {
    // Given a chain that never answers, so every attempt ends on its per-call timeout, and a signal that outlives the
    // call as a subscription's does
    const chain = createFakeChain([], { tail: 'silent' });
    const signal = new CountingSignal();

    // When the call spends its whole budget on per-call timeouts
    const block = createClient(chain.provider)
      // Only the listener calls and `aborted` are read, which the counting signal has.
      .get('bafyLeak', signal as unknown as AbortSignal)
      .catch(() => 'done');
    await timers.advance(185_000);
    await block;

    // Then every listener it registered came off again
    expect(signal.added).toBeGreaterThan(0);
    expect(signal.live).toBe(0);
  });
});

describe('createBitswapClient when the connection cannot send', () => {
  it('As a user, I see a send that throws fail the fetch and leave no abort listener behind', async () => {
    // Given a connection whose send throws, and a signal that outlives the call
    const provider: JsonRpcProvider = () => ({
      send: () => {
        throw new Error('frame vanished');
      },
      disconnect: () => undefined,
    });
    const signal = new CountingSignal();

    // When
    // Only the listener calls and `aborted` are read, which the counting signal has.
    const block = createClient(provider).get('bafySend', signal as unknown as AbortSignal);

    // Then the failure reaches the caller and the call's own listener came off again
    await expect(block).rejects.toThrow('frame vanished');
    expect(signal.added).toBeGreaterThan(0);
    expect(signal.live).toBe(0);
  });
});

describe('createBitswapClient after a halt', () => {
  it('As a dotli user, I still load content after the Bulletin chain halts', async () => {
    // Given a request in flight on a connection that then halts
    const chain = createFakeChain(['silent'], { tail: { hex: '0xabcd' } });
    const block = createClient(chain.provider).get('bafyHalt');
    await timers.advance(100);

    // When the healing lease halts the way the pool halts it: the request in flight is answered with the halted marker
    const halted = getDial(chain.dials, 0);
    halted.onMessage({
      jsonrpc: '2.0',
      id: getSentId(halted, 0),
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    await timers.advance(1_000);

    // Then the retry is answered on the same connection
    await expect(block).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.dials).toHaveLength(1);
    expect(halted.sent).toHaveLength(2);
  });

  it('As a dotli user, I fetch after a connection that never opened and it dials again', async () => {
    // Given a fetch on a connection the protocol frame never opened: the queued request is answered with a closed error
    const chain = createFakeChain(['silent', 'silent']);
    const client = createClient(chain.provider);
    const failed = client.get('bafyNoFrame');
    // Marks the rejection handled while the timers advance.
    const settled = Promise.allSettled([failed]);
    await timers.advance(100);
    const dead = getDial(chain.dials, 0);
    dead.onMessage({
      jsonrpc: '2.0',
      id: getSentId(dead, 0),
      error: { code: -32603, message: 'Chain connection is closed' },
    });
    await settled;

    // When
    const next = client.get('bafyNoFrame');
    await timers.advance(100);
    const redialled = getDial(chain.dials, 1);
    redialled.onMessage({ jsonrpc: '2.0', id: getSentId(redialled, 0), result: '0xabcd' });

    // Then
    await expect(failed).rejects.toThrow('Chain connection is closed');
    await expect(next).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.dials).toHaveLength(2);
    expect(dead.sent).toHaveLength(1);
  });
});

describe('createBitswapClient for one block asked twice', () => {
  it('As a user, I ask for a block while another fetch of it fails and it is fetched on its own within its own budget', async () => {
    // Given a chain that always answers busy, and a first fetch started a minute before the second asks
    const chain = createFakeChain([], { tail: { code: -32812 } });
    const client = createClient(chain.provider);
    let firstSettledAt = -1;
    let secondSettledAt = -1;
    const start = timers.now();
    const first = client.get('bafyBusy').catch(() => {
      firstSettledAt = timers.now() - start;
    });
    await timers.advance(60_000);
    const secondStart = timers.now();
    const second = client.get('bafyBusy').catch((error: unknown) => {
      secondSettledAt = timers.now() - secondStart;
      throw error;
    });
    // Holds the rejection across the timer moves.
    const secondOutcome = Promise.allSettled([second]);

    // When the first fetch spends its budget and fails
    await timers.advance(120_000);
    await first;
    const sentWhenFirstFailed = chain.sent();
    await timers.advance(60_000);
    const [secondResult] = await secondOutcome;

    // Then the second fetched on its own after that, and gave up 180 seconds after its own call, not after the first's
    expect(secondResult).toMatchObject({ status: 'rejected', reason: { name: 'BitswapTimeoutError' } });
    expect(firstSettledAt).toBe(180_000);
    expect(chain.sent()).toBeGreaterThan(sentWhenFirstFailed);
    expect(secondSettledAt).toBe(180_000);
  });

  it('As a user, I see a block whose budget ran out behind another fetch fail without a fetch of its own', async () => {
    // Given two callers asking at once on a chain that always answers busy
    const chain = createFakeChain([], { tail: { code: -32812 } });
    const client = createClient(chain.provider);
    const first = client.get('bafySpent');
    const second = client.get('bafySpent');
    // Holds the rejections across the timer moves.
    const outcomes = Promise.allSettled([first, second]);

    // When
    await timers.advance(180_000);
    const results = await outcomes;
    const sentByFirst = chain.sent();
    await timers.advance(10_000);

    // Then the second sent nothing after the first gave up
    expect(results).toMatchObject([
      { status: 'rejected', reason: { name: 'BitswapTimeoutError' } },
      {
        status: 'rejected',
        reason: {
          name: 'BitswapTimeoutError',
          // Vitest types the matcher `any`, widened so no `any` reaches the expected object.
          message: expect.stringMatching(/\(0 attempts made\)/) as unknown,
        },
      },
    ]);
    expect(chain.sent()).toBe(sentByFirst);
  });

  it('As a user, I ask for the same block from two parts of the page at once and it is fetched once', async () => {
    // Given a chain that answers after a DONT_HAVE, so the first fetch is still running when the second asks
    const chain = createFakeChain([{ code: -32810 }], { tail: { hex: '0xabcd' } });
    const client = createClient(chain.provider);

    // When
    const first = client.get('bafyShared');
    const second = client.get('bafyShared');
    await timers.advance(1_000);

    // Then one fetch served both, each with a buffer of its own
    const [firstBytes, secondBytes] = await Promise.all([first, second]);
    expect(chain.sent()).toBe(2);
    expect(firstBytes).toEqual(new Uint8Array([0xab, 0xcd]));
    expect(secondBytes).toEqual(new Uint8Array([0xab, 0xcd]));
    expect(firstBytes.buffer).not.toBe(secondBytes.buffer);
  });

  it('As a user, I ask for a block again after the first fetch ended and it is fetched again', async () => {
    // Given
    const chain = createFakeChain([{ hex: '0x01' }, { hex: '0x02' }]);
    const client = createClient(chain.provider);
    const first = client.get('bafyAgain');
    await timers.advance(10);
    await first;

    // When
    const second = client.get('bafyAgain');
    await timers.advance(10);

    // Then nothing was kept past the first fetch
    await expect(second).resolves.toEqual(new Uint8Array([0x02]));
    expect(chain.sent()).toBe(2);
  });
});

describe('createBitswapClient connection lifetime', () => {
  it('As a page, my Bulletin connection stays open while another fetch still runs', async () => {
    // Given one fetch that is answered and one the chain never answers
    const chain = createFakeChain([{ hex: '0x01' }, 'silent']);
    const client = createClient(chain.provider);
    const answered = client.get('bafyAnswered');
    void client.get('bafyWaiting');

    // When
    await timers.advance(10);
    await answered;

    // Then
    expect(chain.dials).toHaveLength(1);
    expect(getDial(chain.dials, 0).disconnected).toBe(0);
  });

  it('As a page, my Bulletin connection stays open across a retry wait', async () => {
    // Given a block the peers lack at first
    const chain = createFakeChain([{ code: -32810 }, { hex: '0x01' }]);
    const client = createClient(chain.provider);

    // When the fetch waits between its attempts, and then resolves
    const block = client.get('bafyRetry');
    await timers.advance(100);
    const disconnectedDuringWait = getDial(chain.dials, 0).disconnected;
    await timers.advance(1_000);
    await block;

    // Then one connection served both attempts, and closed only after the fetch resolved
    expect(disconnectedDuringWait).toBe(0);
    expect(chain.sent()).toBe(2);
    expect(chain.dials).toHaveLength(1);
    expect(getDial(chain.dials, 0).disconnected).toBe(1);
  });

  it('As a page, I fetch after the connection closed and it dials again', async () => {
    // Given a fetch that ended and closed its connection
    const chain = createFakeChain([{ hex: '0x01' }, { hex: '0x02' }]);
    const client = createClient(chain.provider);
    const first = client.get('bafyFirst');
    await timers.advance(10);
    await first;

    // When
    const second = client.get('bafySecond');
    await timers.advance(10);

    // Then
    await expect(second).resolves.toEqual(new Uint8Array([0x02]));
    expect(chain.dials).toHaveLength(2);
  });

  it('As a page, I still get my block when closing the connection throws, and the failure is reported', async () => {
    // Given a connection whose close throws
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const chain = createFakeChain([{ hex: '0x01' }, { hex: '0x02' }], { throwingDisconnects: [0] });
    const client = createClient(chain.provider);

    // When
    const first = client.get('bafyFirst');
    await timers.advance(10);
    const firstBytes = await first;
    const second = client.get('bafySecond');
    await timers.advance(10);
    const secondBytes = await second;

    // Then the fetch kept its bytes, the failed close was reported, and the next fetch dialled anew
    expect(firstBytes).toEqual(new Uint8Array([0x01]));
    expect(captured).toMatchObject([{ step: 'bitswap_release', tags: undefined }]);
    expect(sentry.counted('content.bitswap_release')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(secondBytes).toEqual(new Uint8Array([0x02]));
    expect(chain.dials).toHaveLength(2);
  });

  it('As a page, my Bulletin connection closes when I give up on a fetch', async () => {
    // Given a fetch the chain never answers
    const chain = createFakeChain([], { tail: 'silent' });
    const aborter = new AbortController();
    const block = createClient(chain.provider).get('bafyAbandoned', aborter.signal);
    // Holds the rejection across the timer moves.
    const outcome = Promise.allSettled([block]);
    await timers.advance(100);

    // When
    aborter.abort();
    const [result] = await outcome;

    // Then
    expect(result).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    expect(chain.dials).toHaveLength(1);
    expect(getDial(chain.dials, 0).disconnected).toBe(1);
  });

  it('As a page, my Bulletin connection closes when my fetch fails', async () => {
    // Given a chain that answers with a terminal error
    const chain = createFakeChain([{ code: -32602 }]);

    // When
    const block = createClient(chain.provider).get('not-a-cid');
    // Holds the rejection across the timer moves.
    const outcome = Promise.allSettled([block]);
    await timers.advance(100);
    const [result] = await outcome;

    // Then
    expect(result).toMatchObject({ status: 'rejected', reason: { name: 'BitswapRpcError', code: -32602 } });
    expect(chain.dials).toHaveLength(1);
    expect(getDial(chain.dials, 0).disconnected).toBe(1);
  });

  it('As a page, my Bulletin connection closes only after both callers of one block settle', async () => {
    // Given two callers of one block, both waiting on the wire
    const chain = createFakeChain(['silent', 'silent']);
    const client = createClient(chain.provider);
    const aborter = new AbortController();
    const abandoned = client.get('bafyShared', aborter.signal);
    // Holds the rejection across the timer moves.
    const abandonedOutcome = Promise.allSettled([abandoned]);
    const wanted = client.get('bafyShared');
    await timers.advance(100);

    // When the first caller gives up, and the second is then answered
    aborter.abort();
    await abandonedOutcome;
    await timers.advance(100);
    const disconnectedWhileWaiting = getDial(chain.dials, 0).disconnected;
    const dial = getDial(chain.dials, 0);
    dial.onMessage({ jsonrpc: '2.0', id: getSentId(dial, 1), result: '0xabcd' });
    const bytes = await wanted;

    // Then the connection stayed open for the second caller and closed once it settled
    expect(disconnectedWhileWaiting).toBe(0);
    expect(bytes).toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.dials).toHaveLength(1);
    expect(dial.disconnected).toBe(1);
  });
});
