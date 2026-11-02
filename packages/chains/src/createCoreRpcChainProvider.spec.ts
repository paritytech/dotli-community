// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { must } from '@dotli/shared/testing';
import type { JsonRpcProvider } from 'polkadot-api';
import type { JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import {
  createCoreRpcChainProvider,
  getConnectedAssetHubRpcEndpoint,
  getConnectedRpcEndpoint,
  isCoreRpcChainSupported,
} from './createCoreRpcChainProvider.js';
import { FakeWebSocket } from './testing/fakeWebSocket.js';

// The fake implements only the part of WebSocket the provider's sockets use.
const FakeWebSocketClass = FakeWebSocket as unknown as typeof WebSocket;

/** Open a connection on `provider` and its first socket. */
async function connect(
  provider: JsonRpcProvider,
  received: JsonRpcMessage[] = [],
): Promise<{
  socket: FakeWebSocket;
  connection: ReturnType<JsonRpcProvider>;
}> {
  const connection = provider(message => {
    received.push(message);
  });
  await vi.advanceTimersByTimeAsync(0);
  const socket = must(FakeWebSocket.instances.at(-1), 'socket');
  socket.open();
  return { socket, connection };
}

describe('createCoreRpcChainProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a dotli user on Trusted Providers, I reach the People chain over its configured RPC endpoints', async () => {
    // Given
    const people = getActiveServicesConfig().people;

    // When
    const provider = must(
      createCoreRpcChainProvider(people.genesis, { WebSocketBase: FakeWebSocketClass }),
      'People provider',
    );
    const { socket } = await connect(provider);

    // Then
    expect(people.rpcs).toContain(socket.url);
  });

  it('As a product on Trusted Providers, I ask for an unknown chain and get no provider', () => {
    // When
    const supported = isCoreRpcChainSupported('0xdeadbeef');
    const provider = createCoreRpcChainProvider('0xdeadbeef', { WebSocketBase: FakeWebSocketClass });

    // Then
    expect(supported).toBe(false);
    expect(provider).toBeNull();
  });

  it('As a dotli integrator whose host-owned Rust core reads Bulletin, I reach it over its configured RPC endpoints', async () => {
    // Given
    const bulletin = getActiveServicesConfig().bulletin;

    // When
    const coreSupported = isCoreRpcChainSupported(bulletin.genesis);
    const provider = must(
      createCoreRpcChainProvider(bulletin.genesis, { WebSocketBase: FakeWebSocketClass }),
      'Bulletin provider',
    );
    const { socket } = await connect(provider);

    // Then
    expect(coreSupported).toBe(true);
    expect(bulletin.rpcs).toContain(socket.url);
  });

  it("As a dotli integrator, I hear each status change of the chain's socket", async () => {
    // Given
    const onStatus = vi.fn();
    const provider = must(
      createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, {
        hooks: { onStatus },
        WebSocketBase: FakeWebSocketClass,
      }),
      'provider',
    );

    // When
    await connect(provider);

    // Then
    expect(onStatus.mock.calls.map(([status]: unknown[]) => status)).toEqual(['connecting', 'connected']);
  });

  it('As a dotli user on Trusted Providers, I see in diagnostics the node my chain is talking to right now', async () => {
    // Given
    const { genesis } = getActiveServicesConfig().assethub;
    const provider = must(createCoreRpcChainProvider(genesis, { WebSocketBase: FakeWebSocketClass }), 'provider');

    // When
    const connection = provider(() => undefined);
    onTestFinished(() => {
      connection.disconnect();
    });
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
  });

  it('As a dotli user on Trusted Providers, I see in diagnostics the node Asset Hub is talking to', async () => {
    // Given
    const { genesis } = getActiveServicesConfig().assethub;
    const provider = must(createCoreRpcChainProvider(genesis, { WebSocketBase: FakeWebSocketClass }), 'provider');

    // When
    const { socket, connection } = await connect(provider);
    onTestFinished(() => {
      connection.disconnect();
    });

    // Then
    expect(getConnectedAssetHubRpcEndpoint()).toBe(socket.url);
  });

  it('As a dotli user on Trusted Providers, I close the chain connection and diagnostics show no node', async () => {
    // Given
    const { genesis } = getActiveServicesConfig().assethub;
    const provider = must(createCoreRpcChainProvider(genesis, { WebSocketBase: FakeWebSocketClass }), 'provider');

    // When
    const { socket, connection } = await connect(provider);

    // Then
    expect(getConnectedRpcEndpoint(genesis)).toBe(socket.url);

    // When
    connection.disconnect();

    // Then
    expect(getConnectedRpcEndpoint(genesis)).toBeNull();
  });

  it('As a dotli user on Trusted Providers, I keep a quiet socket until it has gone 120 seconds without a message', async () => {
    // Given
    const onStatus = vi.fn();
    const provider = must(
      createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, {
        hooks: { onStatus },
        WebSocketBase: FakeWebSocketClass,
      }),
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

  it('As a dotli user on Trusted Providers, I lose a socket to a heartbeat kill and it is closed, and stays closed when the next one opens', async () => {
    // Given
    const provider = must(
      createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { WebSocketBase: FakeWebSocketClass }),
      'provider',
    );
    const { socket: first } = await connect(provider);

    // When
    await vi.advanceTimersByTimeAsync(120_000);

    // Then ws-provider dropped its listeners and left the socket open, so the provider closes it
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);

    // When
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('As a dotli user on Trusted Providers, I disconnect and a heartbeat-killed socket is closed at once', async () => {
    // Given
    const provider = must(
      createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { WebSocketBase: FakeWebSocketClass }),
      'provider',
    );
    const { socket: first, connection } = await connect(provider);

    // When
    await vi.advanceTimersByTimeAsync(120_000);
    connection.disconnect();
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('As a dotli user on Trusted Providers, I keep my statement subscription under its first id after a reconnect', async () => {
    // Given
    const received: JsonRpcMessage[] = [];
    const provider = must(
      createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { WebSocketBase: FakeWebSocketClass }),
      'provider',
    );
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

  it('As a dotli integrator, I send requests that reach the node with numeric ids and get their responses under my own ids', async () => {
    // Given
    const received: JsonRpcMessage[] = [];
    const provider = must(
      createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { WebSocketBase: FakeWebSocketClass }),
      'provider',
    );
    const { socket, connection } = await connect(provider, received);

    // When
    connection.send({ jsonrpc: '2.0', id: 'core-1', method: 'chainSpec_v1_genesisHash', params: [] });
    const sent = must(socket.requests('chainSpec_v1_genesisHash')[0], 'request');
    socket.deliver({ jsonrpc: '2.0', id: sent.id, result: '0x01' });

    // Then
    expect(typeof sent.id).toBe('number');
    expect(received).toEqual([{ jsonrpc: '2.0', id: 'core-1', result: '0x01' }]);
  });

  it('As a dotli integrator, I get a request in flight when a socket dies answered on the next socket under my own id', async () => {
    // Given
    const received: JsonRpcMessage[] = [];
    const provider = must(
      createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { WebSocketBase: FakeWebSocketClass }),
      'provider',
    );
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

  it('As a dotli user on Trusted Providers, I am served through legacy RPC by a node without chainHead_v1', async () => {
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
      const provider = must(
        createCoreRpcChainProvider(getActiveServicesConfig().people.genesis, { WebSocketBase: FakeWebSocketClass }),
        'provider',
      );
      const { socket, connection } = await connect(provider);

      // When
      connection.send({ jsonrpc: '2.0', id: 'f', method: 'chainHead_v1_follow', params: [true] });
      // The provider writes only JSON-RPC requests to its socket.
      const methodsSent = socket.sent.map(raw => (JSON.parse(raw) as { method: string }).method);

      // Then
      expect(socket.requests('chainHead_v1_follow')).toHaveLength(0);
      expect(methodsSent.some(method => method.startsWith('chain_'))).toBe(true);
    } finally {
      FakeWebSocket.methods = methods;
    }
  });
});
