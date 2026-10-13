// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The pool wired to the real Trusted Providers transport over a fake socket: an integration of the two, so it stays a
// functional test. The pool's own pause and resume rules are unit specs in src/chain-pool.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { must } from '@dotli/shared/testing';
import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { createChainPool, type ChainPool } from '../src/chain-pool.js';
import { createCoreRpcChainProvider } from '../src/rpc-chain.js';
import { FakeWebSocket } from '../src/testing/fake-websocket.js';

function lease(
  pool: ChainPool,
  genesisHash: string,
  onMessage: (message: JsonRpcMessage) => void = () => undefined,
  onHalt?: (error?: unknown) => void,
): JsonRpcConnection {
  return must(pool.getLocalProvider(genesisHash), `provider for ${genesisHash}`)(onMessage, onHalt);
}

describe('createChainPool over Trusted Providers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a dotli user on Trusted Providers, a paused chain closes its socket, and resuming replays its subscription and the sends held meanwhile', async () => {
    // Given
    FakeWebSocket.instances = [];
    const people = getActiveServicesConfig().people.genesis;
    const pool = createChainPool({
      createTransport: (genesisHash, hooks) =>
        createCoreRpcChainProvider(genesisHash, hooks, FakeWebSocket as unknown as typeof WebSocket),
    });
    const received: JsonRpcMessage[] = [];
    const connection = lease(pool, people, message => {
      received.push(message);
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'statement_subscribeStatement', params: [{ matchAll: [] }] });
    await vi.advanceTimersByTimeAsync(0);
    const first = must(FakeWebSocket.instances[0], 'first socket');
    first.open();
    const subscribe = must(first.requests('statement_subscribeStatement')[0], 'subscribe');
    first.deliver({ jsonrpc: '2.0', id: subscribe.id, result: 'srv-1' });
    const localToken = (must(received[0], 'subscribe response') as { result: unknown }).result;

    // When
    pool.pauseAll();
    connection.send({ jsonrpc: '2.0', id: 2, method: 'chainSpec_v1_genesisHash', params: [] });
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(pool.status(people)).toBe('disconnected');

    // When
    pool.resumeAll();
    await vi.advanceTimersByTimeAsync(0);
    const second = must(FakeWebSocket.instances[1], 'second socket');
    second.open();
    const resubscribe = must(second.requests('statement_subscribeStatement')[0], 'resubscribe');
    second.deliver({ jsonrpc: '2.0', id: resubscribe.id, result: 'srv-2' });
    second.deliver({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'srv-2',
        result: { event: 'newStatements', data: { statements: ['0x01'], remaining: 0 } },
      },
    });

    // Then
    expect(second.requests('statement_subscribeStatement')).toHaveLength(1);
    expect(second.requests('chainSpec_v1_genesisHash')).toHaveLength(1);
    expect(received.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: localToken,
        result: { event: 'newStatements', data: { statements: ['0x01'], remaining: 0 } },
      },
    });
  });
});
