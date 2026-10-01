// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Issue #308, end to end through the real host path: Chain.ts, the chain
// pool and broker, and the replaying RPC transport, over a fake server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveServicesConfig, setBackend } from '@dotli/config';
import { FakeWebSocket } from '../../resolver/tests/fake-websocket.js';
import { createChainConnect, createHostChainPool } from '../src/host-callbacks/Chain.js';
import { hexBytes, must, yielded } from './support.js';

const FILTER = [{ matchAny: [`0x${'ab'.repeat(32)}`] }];

function statement(subscription: string, encoded: string): unknown {
  return {
    jsonrpc: '2.0',
    method: 'statement_statement',
    params: { subscription, result: { event: 'newStatements', data: { statements: [encoded], remaining: 0 } } },
  };
}

interface Notification {
  params: { subscription: string; result: { data: { statements: string[] } } };
}

describe('host chain connection over Trusted Providers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    FakeWebSocket.instances = [];
    setBackend('rpc-gateway');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('As a chat user on Trusted Providers, a statement subscription keeps delivering after 120 seconds of quiet', async () => {
    // Given: a core connection to the People chain and an acknowledged subscription.
    const people = getActiveServicesConfig().people.genesis;
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    const next = async (): Promise<unknown> => JSON.parse(yielded(await responses.next())) as unknown;
    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'statement_subscribeStatement', params: FILTER }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const first = must(FakeWebSocket.instances[0], 'first socket');
    first.open();
    const subscribe = must(first.requests('statement_subscribeStatement')[0], 'subscribe');
    first.deliver({ jsonrpc: '2.0', id: subscribe.id, result: 'srv-1' });
    const ack = (await next()) as { id: string; result: string };
    first.deliver(statement('srv-1', '0x01'));
    await vi.advanceTimersByTimeAsync(1_000);
    first.deliver(statement('srv-1', '0x02'));
    const early = [(await next()) as Notification, (await next()) as Notification];

    // When: 120 seconds pass with no traffic, and the heartbeat replaces the socket.
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = must(FakeWebSocket.instances[1], 'second socket');
    second.open();
    const resubscribe = must(second.requests('statement_subscribeStatement')[0], 'resubscribe');
    second.deliver({ jsonrpc: '2.0', id: resubscribe.id, result: 'srv-2' });
    second.deliver(statement('srv-2', '0x03'));
    const late = (await next()) as Notification;

    // Then
    expect(ack.id).toBe('truapi:1');
    expect(early.map(n => [n.params.subscription, n.params.result.data.statements])).toEqual([
      [ack.result, ['0x01']],
      [ack.result, ['0x02']],
    ]);
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(second.requests('statement_subscribeStatement')).toHaveLength(1);
    expect(late.params.subscription).toBe(ack.result);
    expect(late.params.result.data.statements).toEqual(['0x03']);

    // When: the core cancels.
    connection.close();

    // Then: the live server subscription is released and the socket closed.
    expect(second.requests('statement_unsubscribeStatement').map((request): unknown => request.params)).toEqual([
      ['srv-2'],
    ]);
    expect(second.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
