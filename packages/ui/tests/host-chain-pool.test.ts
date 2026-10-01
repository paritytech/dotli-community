// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's chain pool end to end: Chain.ts, the pool and broker, and
// the backend's transport, with the protocol frame's remote connections faked.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, setBackend } from '@dotli/config';
import type { RemoteChainHalt, RemoteChainProvider } from '@dotli/protocol';
import { FakeWebSocket } from '../../resolver/tests/fake-websocket.js';
import type * as ClientModule from '../../protocol/src/client.js';
import { createChainConnect, createHostChainPool, hostChainProvider } from '../src/host-callbacks/Chain.js';
import { hexBytes, must, yielded } from './support.js';

interface RemoteConnection {
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  halt: (reason: RemoteChainHalt) => void;
  disconnect: Mock<() => void>;
}

const mocks = vi.hoisted(() => ({
  createRemoteChainProvider: vi.fn<(genesisHash: string) => RemoteChainProvider | null>(),
}));

vi.mock('../../protocol/src/client.js', async importOriginal => ({
  ...(await importOriginal<typeof ClientModule>()),
  createRemoteChainProvider: mocks.createRemoteChainProvider,
}));

const people = getActiveServicesConfig().people.genesis;

describe('host chain pool on a light client backend', () => {
  let remotes: RemoteConnection[];

  beforeEach(() => {
    vi.useFakeTimers();
    setBackend('smoldot-direct');
    remotes = [];
    mocks.createRemoteChainProvider.mockReset().mockImplementation(() => (onMessage, onHalt) => {
      const remote: RemoteConnection = {
        sent: [],
        emit: onMessage,
        halt: reason => onHalt?.(reason),
        disconnect: vi.fn<() => void>(),
      };
      remotes.push(remote);
      const connection: JsonRpcConnection = {
        send: message => remote.sent.push(message),
        disconnect: remote.disconnect,
      };
      return connection;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("As a dotli user, products' connections to one chain share one connection to the protocol frame", async () => {
    // Given
    const connect = createChainConnect(createHostChainPool());

    // When
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));

    // Then
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledTimes(1);
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledWith(people.toLowerCase());
    expect(remotes).toHaveLength(1);
    first.close();
    second.close();
  });

  it("As a dotli user, a block bar shares the products' connection to the protocol frame", async () => {
    // Given
    const pool = createHostChainPool();
    const connect = createChainConnect(pool);
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));

    // When
    const bar = must(hostChainProvider(people, pool), 'provider')(() => undefined);

    // Then
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledTimes(1);
    expect(remotes).toHaveLength(1);
    first.close();
    second.close();
    bar.disconnect();
  });

  it.each(['chain', 'frame'] as const)(
    'As a dotli user, a %s halt of the connection to the protocol frame reaches a block bar with its reason',
    async reason => {
      // Given
      const pool = createHostChainPool();
      const product = await createChainConnect(pool)(hexBytes(people));
      const onHalt = vi.fn<(reason: RemoteChainHalt) => void>();
      must(hostChainProvider(people, pool), 'provider')(() => undefined, onHalt);

      // When
      must(remotes[0], 'remote').halt(reason);

      // Then
      expect(onHalt).toHaveBeenCalledTimes(1);
      expect(onHalt).toHaveBeenCalledWith(reason);
      expect((await product.responses()[Symbol.asyncIterator]().next()).done).toBe(true);
    },
  );

  it('As a dotli user, a chain the protocol frame cannot serve has no host provider', () => {
    // When
    const provider = hostChainProvider(`0x${'00'.repeat(32)}`, createHostChainPool());

    // Then
    expect(provider).toBeNull();
    expect(mocks.createRemoteChainProvider).not.toHaveBeenCalled();
  });

  it('As a dotli user, the connection to the protocol frame closes 60 seconds after its last lease', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    const remote = must(remotes[0], 'remote');

    // When
    connection.close();
    await vi.advanceTimersByTimeAsync(59_999);

    // Then
    expect(remote.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(remote.disconnect).toHaveBeenCalledTimes(1);
  });

  it("As a dotli user, a dead protocol frame ends a product's connection after what it had queued", async () => {
    // Given: a product request answered by the frame, not yet read.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));
    const remote = must(remotes[0], 'remote');
    remote.emit({ jsonrpc: '2.0', id: must(must(remote.sent[0], 'request').id, 'id'), result: 'People' });

    // When
    remote.halt('frame');

    // Then
    const responses = connection.responses()[Symbol.asyncIterator]();
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', result: 'People' });
    expect((await responses.next()).done).toBe(true);
  });
});

describe('host chain pool over Trusted Providers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    FakeWebSocket.instances = [];
    setBackend('rpc-gateway');
    mocks.createRemoteChainProvider.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("As a dotli user on Trusted Providers, a block bar and a product's connection share one socket", async () => {
    // Given
    const pool = createHostChainPool();
    const product = await createChainConnect(pool)(hexBytes(people));
    const bar = must(hostChainProvider(people, pool), 'provider')(() => undefined);

    // When
    product.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));
    bar.send({ jsonrpc: '2.0', id: 'bar:1', method: 'chainSpec_v1_genesisHash', params: [] });
    await vi.advanceTimersByTimeAsync(0);
    must(FakeWebSocket.instances[0], 'socket').open();

    // Then
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = must(FakeWebSocket.instances[0], 'socket');
    expect(socket.requests('chainSpec_v1_chainName')).toHaveLength(1);
    expect(socket.requests('chainSpec_v1_genesisHash')).toHaveLength(1);
    expect(mocks.createRemoteChainProvider).not.toHaveBeenCalled();
    product.close();
    bar.disconnect();
  });
});
