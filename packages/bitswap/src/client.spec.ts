// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import type { RemoteChainHalt } from '@dotli/chains';
import type { RemoteChainProvider } from '@dotli/protocol';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import { createBitswapClient, type BitswapClient } from './client.js';

type Reply = { code: number; data?: string } | { hex: string } | 'silent';

interface Dial {
  onMessage: (message: JsonRpcMessage) => void;
  onHalt: (reason: RemoteChainHalt) => void;
  /** The ids sent on this connection, in order. */
  sent: number[];
}

/**
 * Stands in for the protocol frame's Bulletin connection. Each `bitswap_v1_get` is answered with the next of `replies`,
 * then with `tail`, unless the reply is `silent`. Every dial opens a new connection.
 */
function fakeChain(
  replies: Reply[] = [],
  tail: Reply = { code: -32810 },
): {
  provider: RemoteChainProvider;
  dials: Dial[];
  sent: () => number;
  gaps: number[];
} {
  const dials: Dial[] = [];
  const gaps: number[] = [];
  let answered = 0;
  let last: number | null = null;
  const provider: RemoteChainProvider = (onMessage, onHalt) => {
    const dial: Dial = { onMessage, onHalt: onHalt ?? (() => undefined), sent: [] };
    dials.push(dial);
    return {
      send: request => {
        const id = (request as { id: number }).id;
        dial.sent.push(id);
        const now = Date.now();
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
      disconnect: () => undefined,
    };
  };
  return { provider, dials, sent: () => dials.reduce((sum, dial) => sum + dial.sent.length, 0), gaps };
}

function dialAt(dials: Dial[], index: number): Dial {
  const dial = dials[index];
  if (dial === undefined) {
    throw new Error(`no connection ${String(index)}`);
  }
  return dial;
}

function sentAt(dial: Dial, index: number): number {
  const id = dial.sent[index];
  if (id === undefined) {
    throw new Error(`no request ${String(index)}`);
  }
  return id;
}

function clientOn(provider: RemoteChainProvider | null): BitswapClient {
  return createBitswapClient({ provider: () => provider });
}

interface LogLine {
  level: LogLevel;
  message: string;
  attrs?: Record<string, unknown> | undefined;
}

function recordLog(): LogLine[] {
  const lines: LogLine[] = [];
  bindLogSink({
    emit: (level, message, attrs) => {
      lines.push({ level, message, attrs });
    },
  });
  return lines;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createBitswapClient retry policy', () => {
  it('As a user, I still load the app when the peer set does not yet hold the CID', async () => {
    // Given the connected peers all answer DONT_HAVE twice before a provider attaches
    const chain = fakeChain([{ code: -32812 }, { code: -32810 }, { code: -32810 }, { hex: '0xabcd' }]);

    // When
    const block = clientOn(chain.provider).get('bafyTest');
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    await expect(block).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.sent()).toBe(4);
  });

  it('As a user, I see a CID no peer ever holds give up after the discovery bound rather than the full budget', async () => {
    // Given every peer keeps answering DONT_HAVE
    const chain = fakeChain();

    // When
    const block = clientOn(chain.provider).get('bafyMissing');
    const settled = expect(block).rejects.toMatchObject({
      name: 'BitswapNotFoundError',
      message: expect.stringMatching(/provider discovery exhausted after 9 failures/) as unknown,
    });
    await vi.advanceTimersByTimeAsync(185_000);
    await settled;

    // Then it stopped at the bound, well short of the three-minute budget
    expect(chain.sent()).toBe(9);
  });

  it('As a user, I keep the discovery allowance through a slow start until discovery begins', async () => {
    // Given three "no peers at all" answers ahead of the DONT_HAVE run
    const chain = fakeChain([{ code: -32812 }, { code: -32812 }, { code: -32812 }]);

    // When
    const block = clientOn(chain.provider).get('bafySlowStart');
    const settled = expect(block).rejects.toThrow(/discovery exhausted/);
    await vi.advanceTimersByTimeAsync(185_000);
    await settled;

    // Then discovery still got its nine tries on top of the three, and its backoff restarted at the base delay
    expect(chain.sent()).toBe(12);
    expect(chain.gaps[3]).toBe(500);
    expect(chain.gaps[4]).toBe(1_000);
  });

  it('As a user, I see a transient retry after a run of DONT_HAVE start below the backoff cap', async () => {
    // Given five discovery failures ahead of two "no peers at all" answers
    const chain = fakeChain([
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
    const block = clientOn(chain.provider).get('bafyTransientRamp');
    await vi.advanceTimersByTimeAsync(60_000);
    await block;

    // Then the transient ramp started at its own base delay
    expect(chain.gaps[5]).toBe(500);
    expect(chain.gaps[6]).toBe(1_000);
  });

  it('As a user, I see a fetch from a chain that keeps answering busy stop at the three-minute budget', async () => {
    // Given every answer is "no peers at all"
    const chain = fakeChain([], { code: -32812 });

    // When
    const block = clientOn(chain.provider).get('bafyBusy');
    const settled = expect(block).rejects.toMatchObject({
      name: 'BitswapTimeoutError',
      message: expect.stringMatching(/timed out after 180000ms/) as unknown,
    });
    await vi.advanceTimersByTimeAsync(185_000);

    // Then
    await settled;
  });

  it('As an integrator, I see a malformed CID fail on the first reply', async () => {
    // Given
    const chain = fakeChain([{ code: -32602 }]);

    // When
    const block = clientOn(chain.provider).get('not-a-cid');
    const settled = expect(block).rejects.toMatchObject({ name: 'BitswapRpcError', code: -32602 });
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    await settled;
    expect(chain.sent()).toBe(1);
  });

  it('As a user on a network whose frame does not serve Bulletin, I see the fetch fail at once as unavailable', async () => {
    // Given no Bulletin provider in the frame's chain set

    // When
    const block = clientOn(null).get('bafyNoBulletin');

    // Then
    await expect(block).rejects.toMatchObject({ name: 'BitswapUnavailableError' });
  });
});

describe('createBitswapClient aborts', () => {
  it('As a user, I navigate away and the fetch stops mid-call instead of finishing the budget', async () => {
    // Given a chain that never replies, so the call is waiting on the wire
    const chain = fakeChain([], 'silent');
    const aborter = new AbortController();
    const block = clientOn(chain.provider).get('bafyInFlight', aborter.signal);
    const settled = expect(block).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringMatching(/aborted/) as unknown,
    });
    await vi.advanceTimersByTimeAsync(100);

    // When
    aborter.abort();

    // Then it gave up at once rather than after the 60s per-call timeout
    await settled;
  });

  it('As a user, I navigate away and the fetch stops mid-backoff too', async () => {
    // Given a retry that is waiting between attempts
    const chain = fakeChain([], { code: -32812 });
    const aborter = new AbortController();
    const block = clientOn(chain.provider).get('bafyBackoff', aborter.signal);
    const settled = expect(block).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(100);
    const sentBeforeAbort = chain.sent();

    // When the abort lands during the backoff rather than during a call
    aborter.abort();
    await settled;
    await vi.advanceTimersByTimeAsync(185_000);

    // Then nothing further was sent
    expect(chain.sent()).toBe(sentBeforeAbort);
  });

  it('As a user, I ask for a fetch with an already-dead signal and it never reaches the chain', async () => {
    // Given
    const chain = fakeChain([{ hex: '0x01' }]);
    const aborter = new AbortController();
    aborter.abort();

    // When
    const block = clientOn(chain.provider).get('bafyDead', aborter.signal);

    // Then
    await expect(block).rejects.toThrow(/aborted/);
    expect(chain.sent()).toBe(0);
  });

  it('As a user, I keep a long-lived subscription and it gathers no abort listeners', async () => {
    // Given a chain that never answers, so every attempt ends on its per-call timeout, and a signal that outlives the
    // call as a subscription's does
    const chain = fakeChain([], 'silent');
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
    const block = clientOn(chain.provider)
      .get('bafyLeak', aborter.signal)
      .catch(() => 'done');
    await vi.advanceTimersByTimeAsync(185_000);
    await block;

    // Then every listener it registered came off again
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});

describe('createBitswapClient after a halt', () => {
  it('As a dotli user, I still load content after the Bulletin chain halts', async () => {
    // Given a request in flight on a connection that then halts
    const lines = recordLog();
    const chain = fakeChain(['silent'], { hex: '0xabcd' });
    const block = clientOn(chain.provider).get('bafyHalt');
    await vi.advanceTimersByTimeAsync(100);

    // When the chain halts the way the pool halts it: the request in flight is answered with the halt first, and the
    // connection hears it after
    const halted = dialAt(chain.dials, 0);
    halted.onMessage({
      jsonrpc: '2.0',
      id: sentAt(halted, 0),
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    halted.onHalt('chain');
    await vi.advanceTimersByTimeAsync(1_000);

    // Then the same call redials and resolves with the second connection's bytes
    await expect(block).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.dials).toHaveLength(2);
    expect(lines).toEqual([
      {
        level: 'info',
        message: 'Bitswap retry',
        attrs: { flow: 'content', cid: 'bafyHalt', attempt: 1, code: -32811, delay_ms: 500 },
      },
    ]);
  });

  it('As a dotli user, I see a request in flight when the protocol frame dies fail at once', async () => {
    // Given a request in flight on a connection that never replies
    const chain = fakeChain(['silent'], { hex: '0xabcd' });
    const client = clientOn(chain.provider);
    const block = client.get('bafyFrame');
    const settled = expect(block).rejects.toMatchObject({
      name: 'BitswapConnectionError',
      message: 'Bulletin connection halted',
    });
    await vi.advanceTimersByTimeAsync(100);

    // When the frame dies
    dialAt(chain.dials, 0).onHalt('frame');

    // Then it fails without waiting for the 60s per-call timeout, and nothing dials during that call
    await settled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chain.dials).toHaveLength(1);

    // And a later fetch dials anew
    const next = client.get('bafyFrame');
    await vi.advanceTimersByTimeAsync(100);
    await expect(next).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.dials).toHaveLength(2);
  });

  it('As a dotli user, I fetch after a connection that never opened and it dials again', async () => {
    // Given a fetch on a connection the protocol frame never opened, closed the way the client closes it: the queued
    // request answered, then a dead frame
    const chain = fakeChain(['silent', 'silent']);
    const client = clientOn(chain.provider);
    const failed = client.get('bafyNoFrame');
    const settled = expect(failed).rejects.toThrow('Chain connection is closed');
    await vi.advanceTimersByTimeAsync(100);
    const dead = dialAt(chain.dials, 0);
    dead.onMessage({
      jsonrpc: '2.0',
      id: sentAt(dead, 0),
      error: { code: -32603, message: 'Chain connection is closed' },
    });
    dead.onHalt('frame');
    await settled;

    // When
    const next = client.get('bafyNoFrame');
    await vi.advanceTimersByTimeAsync(100);
    const redialled = dialAt(chain.dials, 1);
    redialled.onMessage({ jsonrpc: '2.0', id: sentAt(redialled, 0), result: '0xabcd' });

    // Then
    await expect(next).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.dials).toHaveLength(2);
    expect(dead.sent).toHaveLength(1);
  });

  it('As a dotli user, I keep the new Bulletin connection working through a late halt from the replaced one', async () => {
    // Given a fetch that redialled after its chain halted, with a request in flight on the new connection
    const lines = recordLog();
    const chain = fakeChain([], 'silent');
    const client = clientOn(chain.provider);
    const fetching = client.get('bafyReplaced');
    let settled = false;
    void fetching.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    const replaced = dialAt(chain.dials, 0);
    replaced.onMessage({
      jsonrpc: '2.0',
      id: sentAt(replaced, 0),
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    replaced.onHalt('chain');
    await vi.advanceTimersByTimeAsync(1_000);
    const current = dialAt(chain.dials, 1);
    expect(current.sent).toHaveLength(1);

    // When the replaced connection hears a halt again
    replaced.onHalt('frame');
    await vi.advanceTimersByTimeAsync(100);

    // Then the request on the new connection is still pending, and is served there
    expect(settled).toBe(false);
    current.onMessage({ jsonrpc: '2.0', id: sentAt(current, 0), result: '0xabcd' });
    await expect(fetching).resolves.toEqual(new Uint8Array([0xab, 0xcd]));

    // And the next fetch uses the new connection without dialling
    const next = client.get('bafyReplaced');
    await vi.advanceTimersByTimeAsync(100);
    current.onMessage({ jsonrpc: '2.0', id: sentAt(current, 1), result: '0xef' });
    await expect(next).resolves.toEqual(new Uint8Array([0xef]));
    expect(chain.dials).toHaveLength(2);
    expect(lines).toEqual([
      {
        level: 'info',
        message: 'Bitswap retry',
        attrs: { flow: 'content', cid: 'bafyReplaced', attempt: 1, code: -32811, delay_ms: 500 },
      },
    ]);
  });
});

describe('createBitswapClient redial', () => {
  it('As a dotli user, I redial after a halt and the Bulletin provider is asked for again and used', async () => {
    // Given a client whose provider getter hands out a different chain on each read
    const before = fakeChain(['silent']);
    const after = fakeChain([], { hex: '0xabcd' });
    const providers = [before.provider, after.provider];
    let reads = 0;
    const client = createBitswapClient({
      provider: () => providers[Math.min(reads++, providers.length - 1)] ?? null,
    });
    const block = client.get('bafyRedial');
    await vi.advanceTimersByTimeAsync(100);

    // When the first connection halts with the request unanswered
    dialAt(before.dials, 0).onHalt('chain');
    await vi.advanceTimersByTimeAsync(1_000);

    // Then the retry went to the second provider
    await expect(block).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(reads).toBe(2);
    expect(after.sent()).toBe(1);
    expect(before.sent()).toBe(1);
  });
});

describe('createBitswapClient for one block asked twice', () => {
  it('As a user, I ask for a block while another fetch of it fails and it is fetched on its own within its own budget', async () => {
    // Given a chain that always answers busy, and a first fetch started a minute before the second asks
    const chain = fakeChain([], { code: -32812 });
    const client = clientOn(chain.provider);
    let firstSettledAt = -1;
    let secondSettledAt = -1;
    const start = Date.now();
    const first = client.get('bafyBusy').catch(() => {
      firstSettledAt = Date.now() - start;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const secondStart = Date.now();
    const second = client.get('bafyBusy').catch((err: unknown) => {
      secondSettledAt = Date.now() - secondStart;
      throw err;
    });
    const secondFailure = expect(second).rejects.toMatchObject({ name: 'BitswapTimeoutError' });

    // When the first fetch spends its budget and fails
    await vi.advanceTimersByTimeAsync(120_000);
    await first;
    const sentWhenFirstFailed = chain.sent();
    await vi.advanceTimersByTimeAsync(60_000);
    await secondFailure;

    // Then the second fetched on its own after that, and gave up 180 seconds after its own call, not after the first's
    expect(firstSettledAt).toBe(180_000);
    expect(chain.sent()).toBeGreaterThan(sentWhenFirstFailed);
    expect(secondSettledAt).toBe(180_000);
  });

  it('As a user, I see a block whose budget ran out behind another fetch fail without a fetch of its own', async () => {
    // Given two callers asking at once on a chain that always answers busy
    const chain = fakeChain([], { code: -32812 });
    const client = clientOn(chain.provider);
    const first = client.get('bafySpent');
    const second = client.get('bafySpent');
    const failures = Promise.all([
      expect(first).rejects.toMatchObject({ name: 'BitswapTimeoutError' }),
      expect(second).rejects.toMatchObject({
        name: 'BitswapTimeoutError',
        message: expect.stringMatching(/\(0 attempts made\)/) as unknown,
      }),
    ]);

    // When
    await vi.advanceTimersByTimeAsync(180_000);
    await failures;

    // Then the second sent nothing after the first gave up
    const sentByFirst = chain.sent();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chain.sent()).toBe(sentByFirst);
  });

  it('As a user, I ask for the same block from two parts of the page at once and it is fetched once', async () => {
    // Given a chain that answers after a DONT_HAVE, so the first fetch is still running when the second asks
    const chain = fakeChain([{ code: -32810 }], { hex: '0xabcd' });
    const client = clientOn(chain.provider);

    // When
    const first = client.get('bafyShared');
    const second = client.get('bafyShared');
    await vi.advanceTimersByTimeAsync(1_000);

    // Then one fetch served both, each with a buffer of its own
    const [a, b] = await Promise.all([first, second]);
    expect(chain.sent()).toBe(2);
    expect(a).toEqual(new Uint8Array([0xab, 0xcd]));
    expect(b).toEqual(new Uint8Array([0xab, 0xcd]));
    expect(a.buffer).not.toBe(b.buffer);
  });

  it('As a user, I give up on a block in one part of the page and it is still fetched for the other', async () => {
    // Given a first fetch held on the wire, and a second waiting for it
    const chain = fakeChain(['silent'], { hex: '0xabcd' });
    const client = clientOn(chain.provider);
    const aborter = new AbortController();
    const abandoned = client.get('bafyHalfWanted', aborter.signal);
    const settled = expect(abandoned).rejects.toThrow(/aborted/);
    const wanted = client.get('bafyHalfWanted');
    await vi.advanceTimersByTimeAsync(100);

    // When the first gives up
    aborter.abort();
    await settled;
    await vi.advanceTimersByTimeAsync(100);

    // Then the second fetches the block itself
    await expect(wanted).resolves.toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chain.sent()).toBe(2);
  });

  it('As a user, I ask for a block again after the first fetch ended and it is fetched again', async () => {
    // Given
    const chain = fakeChain([{ hex: '0x01' }, { hex: '0x02' }]);
    const client = clientOn(chain.provider);
    const first = client.get('bafyAgain');
    await vi.advanceTimersByTimeAsync(10);
    await first;

    // When
    const second = client.get('bafyAgain');
    await vi.advanceTimersByTimeAsync(10);

    // Then nothing was kept past the first fetch
    await expect(second).resolves.toEqual(new Uint8Array([0x02]));
    expect(chain.sent()).toBe(2);
  });
});
