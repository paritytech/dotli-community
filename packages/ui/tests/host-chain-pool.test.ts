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

const mocks = vi.hoisted(() => {
  // Never cleared: the host pool's frame gate subscribes once, for good.
  const readyListeners: (() => void)[] = [];
  return {
    createRemoteChainProvider: vi.fn<(genesisHash: string) => RemoteChainProvider | null>(),
    isProtocolReady: vi.fn<() => boolean>(),
    readyListeners,
    onProtocolReady: vi.fn<(listener: () => void) => () => void>(listener => {
      readyListeners.push(listener);
      return () => undefined;
    }),
  };
});

vi.mock('../../protocol/src/client.js', async importOriginal => ({
  ...(await importOriginal<typeof ClientModule>()),
  createRemoteChainProvider: mocks.createRemoteChainProvider,
  isProtocolReady: mocks.isProtocolReady,
  onProtocolReady: mocks.onProtocolReady,
}));

/** The protocol frame reports ready, which also reopens the host pool's frame gate. */
function frameReady(): void {
  mocks.isProtocolReady.mockReturnValue(true);
  for (const listener of mocks.readyListeners) {
    listener();
  }
}

const people = getActiveServicesConfig().people.genesis;

describe('host chain pool on a light client backend', () => {
  let remotes: RemoteConnection[];
  // Set, every new remote connection is refused by the frame, as a frame
  // whose light client hit a fatal refuses it.
  let refuse: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    setBackend('smoldot-direct');
    remotes = [];
    refuse = false;
    // A gate left shut by an earlier test is reset, then the frame is down.
    frameReady();
    mocks.isProtocolReady.mockReturnValue(false);
    mocks.createRemoteChainProvider.mockReset().mockImplementation(() => (onMessage, onHalt) => {
      const remote: RemoteConnection = {
        sent: [],
        emit: onMessage,
        halt: reason => onHalt?.(reason),
        disconnect: vi.fn<() => void>(),
      };
      remotes.push(remote);
      if (refuse) {
        queueMicrotask(() => {
          remote.halt('frame');
        });
      }
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
      product.close();
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

  it.each([
    { reason: 'chain', ready: false },
    { reason: 'frame', ready: true },
  ] as const)(
    "As a dotli user, a product's chain connection outlives a $reason halt: what was queued arrives, and its next request opens a fresh connection to the frame",
    async ({ reason, ready }) => {
      // Given: a product request answered by the frame, not yet read (after
      // a frame halt, a frame something else started is up again).
      const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
      const responses = connection.responses()[Symbol.asyncIterator]();
      connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));
      const first = must(remotes[0], 'first remote');
      first.emit({ jsonrpc: '2.0', id: must(must(first.sent[0], 'request').id, 'id'), result: 'People' });

      // When: the connection to the frame halts, then the product asks again.
      first.halt(reason);
      if (ready) {
        frameReady();
      }
      connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));

      // Then: the queued answer arrives, a new remote connection carries the
      // next request, and its answer reaches the same stream.
      expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', result: 'People' });
      expect(remotes).toHaveLength(2);
      const second = must(remotes[1], 'second remote');
      expect(first.sent).toHaveLength(1);
      second.emit({ jsonrpc: '2.0', id: must(must(second.sent[0], 'request').id, 'id'), result: 'People again' });
      expect(JSON.parse(yielded(await responses.next()))).toEqual({
        jsonrpc: '2.0',
        id: 'truapi:2',
        result: 'People again',
      });
      connection.close();
      expect((await responses.next()).done).toBe(true);
    },
  );

  it('As a dotli user, a product retrying after the protocol frame died boots a new frame only as the backoff allows', async () => {
    // Given: the frame died, and every new frame refuses the connection.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');
    refuse = true;

    // When: the product's papi client retries every 250 ms for a minute.
    for (let i = 0; i < 240; i++) {
      connection.send(
        JSON.stringify({ jsonrpc: '2.0', id: `truapi:${String(i)}`, method: 'chainHead_v1_follow', params: [true] }),
      );
      await vi.advanceTimersByTimeAsync(250);
    }

    // Then: a new frame is tried at 1 s, 3 s, 7 s, 15 s and 31 s, and no more.
    expect(remotes).toHaveLength(6);
    connection.close();
  });

  it('As a dotli user, a request after the protocol frame died is answered at once while the backoff is shut', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(remotes[0], 'first remote').halt('frame');

    // When
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));
    connection.send(JSON.stringify({ jsonrpc: '2.0', method: 'chainSpec_v1_chainName', params: [] }));

    // Then: the request gets the halted error, the notification nothing, and no frame is dialled.
    expect(JSON.parse(yielded(await responses.next()))).toEqual({
      jsonrpc: '2.0',
      id: 'truapi:2',
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    expect(remotes).toHaveLength(1);
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it('As a dotli user, two products after the protocol frame died boot one frame per backoff window', async () => {
    // Given
    const connect = createChainConnect(createHostChainPool());
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');

    // When: the window opens, and both products ask.
    await vi.advanceTimersByTimeAsync(1_000);
    first.send(JSON.stringify({ jsonrpc: '2.0', id: 'a:1', method: 'chainSpec_v1_chainName', params: [] }));
    second.send(JSON.stringify({ jsonrpc: '2.0', id: 'b:1', method: 'chainSpec_v1_chainName', params: [] }));

    // Then: only the first one dialled.
    expect(remotes).toHaveLength(2);
    expect(must(remotes[1], 'second remote').sent).toHaveLength(1);
    first.close();
    second.close();
  });

  it('As a dotli user, the protocol frame coming back resets the backoff', async () => {
    // Given: a frame halt, and a retry through the 1 s window that was refused,
    // so the next window would be 2 s away.
    const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
    must(remotes[0], 'first remote').halt('frame');
    await vi.advanceTimersByTimeAsync(1_000);
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));
    must(remotes[1], 'second remote').halt('frame');

    // When: a frame something else started comes up, and the product asks.
    frameReady();
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));

    // Then: it dials at once; and when that frame dies too, the next window is 1 s away again.
    expect(remotes).toHaveLength(3);
    mocks.isProtocolReady.mockReturnValue(false);
    must(remotes[2], 'third remote').halt('frame');
    await vi.advanceTimersByTimeAsync(999);
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:3', method: 'chainSpec_v1_chainName', params: [] }));
    expect(remotes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:4', method: 'chainSpec_v1_chainName', params: [] }));
    expect(remotes).toHaveLength(4);
    connection.close();
  });

  it('As a dotli user, a block bar after a halt opens a fresh connection to the frame', () => {
    // Given
    const pool = createHostChainPool();
    const provider = must(hostChainProvider(people, pool), 'provider');
    provider(
      () => undefined,
      () => undefined,
    );
    must(remotes[0], 'first remote').halt('chain');

    // When
    const bar = provider(() => undefined);
    bar.send({ jsonrpc: '2.0', id: 'bar:1', method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(remotes).toHaveLength(2);
    expect(must(remotes[1], 'second remote').sent).toHaveLength(1);
    bar.disconnect();
  });

  it('As a dotli user, the connection to the protocol frame closes 60 seconds after the last of two leases', async () => {
    // Given
    const connect = createChainConnect(createHostChainPool());
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));
    const remote = must(remotes[0], 'remote');

    // When: one lease is released, and the other a while later.
    first.close();
    await vi.advanceTimersByTimeAsync(30_000);
    second.close();
    await vi.advanceTimersByTimeAsync(59_999);

    // Then: the countdown started at the second release.
    expect(remote.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(remote.disconnect).toHaveBeenCalledTimes(1);
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
