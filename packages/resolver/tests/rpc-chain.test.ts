// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import {
  createCoreRpcChainProvider,
  createRpcChainProvider,
  isCoreRpcChainSupported,
  isRpcChainSupported,
  type RpcChainProvider,
} from '../src/rpc-chain.js';
import { FakeWebSocket } from './fake-websocket.js';

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

/** Open a connection on `provider` and its first socket. */
async function connect(provider: RpcChainProvider, received: JsonRpcMessage[] = []): Promise<{
  socket: FakeWebSocket;
  connection: ReturnType<RpcChainProvider>;
}> {
  const connection = provider(message => {
    received.push(message);
  });
  await vi.advanceTimersByTimeAsync(0);
  const socket = must(FakeWebSocket.instances.at(-1), 'socket');
  socket.open();
  return { socket, connection };
}

describe('rpc-chain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('As a dotli user on Trusted Providers, the People chain is reached over its configured RPC endpoints', async () => {
    // Given
    const people = getActiveServicesConfig().people;

    // When
    const provider = must(createRpcChainProvider(people.genesis), 'People provider');
    const { socket } = await connect(provider);

    // Then
    expect(isRpcChainSupported(people.genesis)).toBe(true);
    expect(people.rpcs).toContain(socket.url);
    expect(typeof provider.pause).toBe('function');
    expect(typeof provider.resume).toBe('function');
  });

  it('rejects unknown genesis hashes', () => {
    expect(isRpcChainSupported('0xdeadbeef')).toBe(false);
    expect(createRpcChainProvider('0xdeadbeef')).toBeNull();
  });

  it('As a dotli integrator, the host reserves Bulletin RPC access for the host-owned Rust core', () => {
    // Given
    const bulletin = getActiveServicesConfig().bulletin;

    // When
    const productSupported = isRpcChainSupported(bulletin.genesis);
    const productProvider = createRpcChainProvider(bulletin.genesis);
    const coreSupported = isCoreRpcChainSupported(bulletin.genesis);
    const coreProvider = createCoreRpcChainProvider(bulletin.genesis);

    // Then
    expect(productSupported).toBe(false);
    expect(productProvider).toBeNull();
    expect(coreSupported).toBe(true);
    expect(coreProvider).not.toBeNull();
  });

  it('As a dotli integrator, the socket reports its status to the pool', async () => {
    // Given
    const onStatus = vi.fn();
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { onStatus }), 'provider');

    // When
    await connect(provider);

    // Then
    expect(onStatus.mock.calls.map(([status]: unknown[]) => status)).toEqual(['connecting', 'connected']);
  });

  it('As a dotli user on Trusted Providers, a socket counts as dead only after 120 seconds without a message', async () => {
    // Given
    const onStatus = vi.fn();
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { onStatus }), 'provider');
    const { socket } = await connect(provider);
    onStatus.mockClear();

    // When
    await vi.advanceTimersByTimeAsync(119_999);

    // Then
    expect(onStatus).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    // When
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(onStatus).toHaveBeenCalledWith('disconnected');
  });

  it('As a dotli user on Trusted Providers, the socket abandoned by a heartbeat kill is closed when the next one opens', async () => {
    // Given
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
    const { socket: first } = await connect(provider);

    // When
    await vi.advanceTimersByTimeAsync(120_000);

    // Then: ws-provider dropped its listeners but left the socket open.
    expect(first.readyState).toBe(FakeWebSocket.OPEN);

    // When
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('As a dotli user on Trusted Providers, a statement subscription is re-established under its first id after a reconnect', async () => {
    // Given
    const received: JsonRpcMessage[] = [];
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
    const { socket: first, connection } = await connect(provider, received);
    connection.send({ jsonrpc: '2.0', id: 'sub', method: 'statement_subscribeStatement', params: [{ matchAll: [] }] });
    first.deliver({ jsonrpc: '2.0', id: 'sub', result: 'srv-1' });

    // When
    await vi.advanceTimersByTimeAsync(121_000);
    const second = must(FakeWebSocket.instances[1], 'second socket');
    second.open();
    const resubscribe = must(second.requests('statement_subscribeStatement')[0], 'resubscribe');
    second.deliver({ jsonrpc: '2.0', id: resubscribe.id, result: 'srv-2' });
    second.deliver({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: { subscription: 'srv-2', result: { event: 'newStatements', data: { statements: ['0x03'], remaining: 0 } } },
    });

    // Then
    expect(second.requests('statement_subscribeStatement')).toHaveLength(1);
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 'sub', result: 'srv-1' },
      {
        jsonrpc: '2.0',
        method: 'statement_statement',
        params: { subscription: 'srv-1', result: { event: 'newStatements', data: { statements: ['0x03'], remaining: 0 } } },
      },
    ]);
  });
});
