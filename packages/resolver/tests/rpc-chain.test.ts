// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import {
  createCoreRpcChainProvider,
  createRpcChainProvider,
  getConnectedRpcEndpoint,
  isCoreRpcChainSupported,
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
async function connect(
  provider: RpcChainProvider,
  received: JsonRpcMessage[] = [],
): Promise<{
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
    expect(people.rpcs).toContain(socket.url);
    expect(typeof provider.pause).toBe('function');
    expect(typeof provider.resume).toBe('function');
  });

  it('rejects unknown genesis hashes', () => {
    expect(isCoreRpcChainSupported('0xdeadbeef')).toBe(false);
    expect(createRpcChainProvider('0xdeadbeef')).toBeNull();
  });

  it('As a dotli integrator, the host reserves Bulletin RPC access for the host-owned Rust core', () => {
    // Given
    const bulletin = getActiveServicesConfig().bulletin;

    // When
    const productProvider = createRpcChainProvider(bulletin.genesis);
    const coreSupported = isCoreRpcChainSupported(bulletin.genesis);
    const coreProvider = createCoreRpcChainProvider(bulletin.genesis);

    // Then
    expect(productProvider).toBeNull();
    expect(coreSupported).toBe(true);
    expect(coreProvider).not.toBeNull();
  });

  it('As a dotli integrator, the socket reports its status to the pool', async () => {
    // Given
    const onStatus = vi.fn();
    const provider = must(
      createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { onStatus }),
      'provider',
    );

    // When
    await connect(provider);

    // Then
    expect(onStatus.mock.calls.map(([status]: unknown[]) => status)).toEqual(['connecting', 'connected']);
  });

  it('As a dotli user on Trusted Providers, diagnostics show the node my chain is talking to right now', async () => {
    // Given
    const { genesis } = getActiveServicesConfig().assethub;
    const provider = must(createCoreRpcChainProvider(genesis), 'provider');

    // When
    const connection = provider(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const first = must(FakeWebSocket.instances.at(-1), 'first socket');

    // Then
    expect(getConnectedRpcEndpoint(genesis)).toBe(first.url);

    // When
    first.open();

    // Then
    expect(getConnectedRpcEndpoint(genesis)).toBe(first.url);

    // When
    await vi.advanceTimersByTimeAsync(120_000);

    // Then
    expect(getConnectedRpcEndpoint(genesis)).toBeNull();

    // When
    await vi.advanceTimersByTimeAsync(1_000);
    const second = must(FakeWebSocket.instances.at(-1), 'second socket');

    // Then
    expect(second).not.toBe(first);
    expect(getConnectedRpcEndpoint(genesis)).toBe(second.url);
    expect(getConnectedRpcEndpoint('0xdeadbeef')).toBeNull();
    connection.disconnect();
  });

  it('As a dotli user on Trusted Providers, diagnostics show no node once the chain connection is closed or paused', async () => {
    // Given
    const { genesis } = getActiveServicesConfig().assethub;
    const provider = must(createCoreRpcChainProvider(genesis), 'provider');
    const { socket, connection } = await connect(provider);
    expect(getConnectedRpcEndpoint(genesis)).toBe(socket.url);

    // When
    connection.disconnect();

    // Then
    expect(getConnectedRpcEndpoint(genesis)).toBeNull();

    // When
    await connect(provider);
    const dialed = getConnectedRpcEndpoint(genesis);
    provider.pause();

    // Then
    expect(dialed).not.toBeNull();
    expect(getConnectedRpcEndpoint(genesis)).toBeNull();
  });

  it('As a dotli user on Trusted Providers, a socket counts as dead only after 120 seconds without a message', async () => {
    // Given
    const onStatus = vi.fn();
    const provider = must(
      createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { onStatus }),
      'provider',
    );
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

  it('As a dotli user on Trusted Providers, the socket abandoned by a heartbeat kill is closed, and stays closed when the next one opens', async () => {
    // Given
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
    const { socket: first } = await connect(provider);

    // When
    await vi.advanceTimersByTimeAsync(120_000);

    // Then: ws-provider dropped its listeners and left the socket open; the provider closes it.
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);

    // When
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('As a dotli user on Trusted Providers, a heartbeat-killed socket is closed at once when the connection is disconnected', async () => {
    // Given
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
    const { socket: first, connection } = await connect(provider);

    // When
    await vi.advanceTimersByTimeAsync(120_000);
    connection.disconnect();
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('As a dotli user on Trusted Providers, a heartbeat-killed socket is closed at once when the provider is paused', async () => {
    // Given
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
    const { socket: first } = await connect(provider);

    // When
    await vi.advanceTimersByTimeAsync(120_000);
    provider.pause();

    // Then
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('As a dotli user on Trusted Providers, a statement subscription is re-established under its first id after a reconnect', async () => {
    // Given
    const received: JsonRpcMessage[] = [];
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
    const { socket: first, connection } = await connect(provider, received);
    connection.send({ jsonrpc: '2.0', id: 'sub', method: 'statement_subscribeStatement', params: [{ matchAll: [] }] });
    const firstSubscribe = must(first.requests('statement_subscribeStatement')[0], 'first subscribe');
    first.deliver({ jsonrpc: '2.0', id: firstSubscribe.id, result: 'srv-1' });

    // When
    await vi.advanceTimersByTimeAsync(121_000);
    const second = must(FakeWebSocket.instances[1], 'second socket');
    second.open();
    const resubscribe = must(second.requests('statement_subscribeStatement')[0], 'resubscribe');
    second.deliver({ jsonrpc: '2.0', id: resubscribe.id, result: 'srv-2' });
    second.deliver({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: {
        subscription: 'srv-2',
        result: { event: 'newStatements', data: { statements: ['0x03'], remaining: 0 } },
      },
    });

    // Then
    expect(second.requests('statement_subscribeStatement')).toHaveLength(1);
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 'sub', result: 'srv-1' },
      {
        jsonrpc: '2.0',
        method: 'statement_statement',
        params: {
          subscription: 'srv-1',
          result: { event: 'newStatements', data: { statements: ['0x03'], remaining: 0 } },
        },
      },
    ]);
  });

  it('As a dotli user on Trusted Providers, every new chain socket first asks the node which methods it serves', async () => {
    // Given
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
    const { socket: first, connection } = await connect(provider);
    connection.send({ jsonrpc: '2.0', id: 'a', method: 'chainSpec_v1_genesisHash', params: [] });

    // When
    await vi.advanceTimersByTimeAsync(121_000);
    const second = must(FakeWebSocket.instances[1], 'second socket');
    second.open();

    // Then
    expect(first.sent.map(raw => (JSON.parse(raw) as { method: string }).method)[0]).toBe('rpc_methods');
    expect(second.sent.map(raw => (JSON.parse(raw) as { method: string }).method)[0]).toBe('rpc_methods');
  });

  it("As a dotli integrator, requests reach the node with numeric ids and their responses keep the caller's id", async () => {
    // Given
    const received: JsonRpcMessage[] = [];
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
    const { socket, connection } = await connect(provider, received);

    // When
    connection.send({ jsonrpc: '2.0', id: 'core-1', method: 'chainSpec_v1_genesisHash', params: [] });
    const sent = must(socket.requests('chainSpec_v1_genesisHash')[0], 'request');
    socket.deliver({ jsonrpc: '2.0', id: sent.id, result: '0x01' });

    // Then
    expect(typeof sent.id).toBe('number');
    expect(received).toEqual([{ jsonrpc: '2.0', id: 'core-1', result: '0x01' }]);
  });

  it("As a dotli integrator, a request in flight when a socket dies is answered on the next socket under the caller's id", async () => {
    // Given
    const received: JsonRpcMessage[] = [];
    const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
    const { connection } = await connect(provider, received);
    connection.send({ jsonrpc: '2.0', id: 'core-1', method: 'chainSpec_v1_genesisHash', params: [] });

    // When
    await vi.advanceTimersByTimeAsync(121_000);
    const second = must(FakeWebSocket.instances[1], 'second socket');
    second.open();
    const resent = must(second.requests('chainSpec_v1_genesisHash')[0], 're-sent request');
    second.deliver({ jsonrpc: '2.0', id: resent.id, result: '0x01' });

    // Then
    expect(received).toEqual([{ jsonrpc: '2.0', id: 'core-1', result: '0x01' }]);
  });

  it('As a dotli user on Trusted Providers, a node without chainHead_v1 is served through legacy RPC', async () => {
    // Given
    const methods = FakeWebSocket.methods;
    FakeWebSocket.methods = [
      'chain_getBlockHash',
      'chain_getHeader',
      'chain_subscribeNewHeads',
      'chain_unsubscribeNewHeads',
      'chain_subscribeFinalizedHeads',
      'chain_unsubscribeFinalizedHeads',
      'state_getRuntimeVersion',
      'state_getMetadata',
      'rpc_methods',
    ];
    try {
      const provider = must(createCoreRpcChainProvider(getActiveServicesConfig().people.genesis), 'provider');
      const { socket, connection } = await connect(provider);

      // When
      connection.send({ jsonrpc: '2.0', id: 'f', method: 'chainHead_v1_follow', params: [true] });

      // Then
      const methodsSent = socket.sent.map(raw => (JSON.parse(raw) as { method: string }).method);
      expect(socket.requests('chainHead_v1_follow')).toHaveLength(0);
      expect(methodsSent.some(method => method.startsWith('chain_'))).toBe(true);
    } finally {
      FakeWebSocket.methods = methods;
    }
  });
});
