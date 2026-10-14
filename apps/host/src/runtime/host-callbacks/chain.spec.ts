// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getSettings, setSettings, type Backend } from '@dotli/config';
import type { ChainActivity, ChainPool, LeaseProvider, RemoteChainHalt } from '@dotli/chains';
import type { RemoteChainProvider } from '@dotli/protocol';
import { createCoreRpcChainProvider } from '@dotli/chains';
import { FakeWebSocket } from '@dotli/chains/testing';
import { must } from '@dotli/shared/testing';
import {
  createChainConnect,
  createHostChainPool,
  hostAssetHubProvider,
  hostChainProvider,
  type HostChainSources,
  watchHostChains,
} from './chain.js';
import { hexBytes, yielded } from '../../testing/fixtures.js';

/** Trusted Providers' sockets, over the fake server. */
const fakeSocketChain: HostChainSources['rpcChain'] = (genesisHash, hooks) =>
  createCoreRpcChainProvider(genesisHash, hooks, FakeWebSocket as unknown as typeof WebSocket);

interface Upstream {
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  /** The chain dies, as its transport reports it. */
  halt: () => void;
  disconnect: Mock<() => void>;
  opened: number;
}

/** Both backends' chains, recording each transport built in `upstreams`, on the backend a test sets. */
interface FakeSources extends HostChainSources {
  upstreams: Upstream[];
  setBackend: (backend: Backend) => void;
  remoteChain: Mock<HostChainSources['remoteChain']>;
  rpcChain: Mock<HostChainSources['rpcChain']>;
  isRemoteChainConnectable: Mock<HostChainSources['isRemoteChainConnectable']>;
  isRpcChainSupported: Mock<HostChainSources['isRpcChainSupported']>;
}

function newUpstream(): Upstream {
  return { sent: [], emit: () => undefined, halt: () => undefined, disconnect: vi.fn<() => void>(), opened: 0 };
}

function connectUpstream(upstream: Upstream, onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
  upstream.opened += 1;
  upstream.emit = onMessage;
  return {
    send(message) {
      upstream.sent.push(message);
    },
    disconnect: upstream.disconnect,
  };
}

function fakeSources(): FakeSources {
  const upstreams: Upstream[] = [];
  let backend: Backend = 'smoldot-shared-worker';
  return {
    upstreams,
    setBackend: next => {
      backend = next;
    },
    backend: () => backend,
    isRemoteChainConnectable: vi.fn<HostChainSources['isRemoteChainConnectable']>(() => true),
    isRpcChainSupported: vi.fn<HostChainSources['isRpcChainSupported']>(() => true),
    remoteChain: vi.fn<HostChainSources['remoteChain']>(() => {
      const upstream = newUpstream();
      upstreams.push(upstream);
      return (onMessage, onHalt) => {
        upstream.halt = () => {
          onHalt?.('chain');
        };
        return connectUpstream(upstream, onMessage);
      };
    }),
    rpcChain: vi.fn<HostChainSources['rpcChain']>((_genesisHash, hooks) => {
      const upstream = newUpstream();
      upstream.halt = () => {
        hooks.onStatus('disconnected');
        hooks.onHalt(new Error('socket gone'));
      };
      upstreams.push(upstream);
      return onMessage => connectUpstream(upstream, onMessage);
    }),
  };
}

/** A product's chain connect on its own page pool, whose chains close at once unless `pool` says otherwise. */
function connectOn(
  sources: FakeSources,
  pool: { destroyDelay?: number } = { destroyDelay: 0 },
): ReturnType<typeof createChainConnect> {
  return createChainConnect(createHostChainPool({ ...sources, ...pool }), sources);
}

describe('createChainConnect', () => {
  let people: string;
  let assetHub: string;
  let sources: FakeSources;

  beforeEach(() => {
    people = getActiveServicesConfig().people.genesis;
    assetHub = getActiveServicesConfig().assethub.genesis;
    sources = fakeSources();
  });

  it("As a dotli integrator, the host routes chain connections on a light client backend through the protocol frame's light client", async () => {
    // When
    await connectOn(sources)(hexBytes(people));

    // Then
    expect(sources.remoteChain).toHaveBeenCalledWith(people.toLowerCase());
    expect(sources.rpcChain).not.toHaveBeenCalled();
  });

  it('As a dotli user on Trusted Providers, the host routes chain connections through the core RPC transport', async () => {
    // Given
    sources.setBackend('rpc-gateway');

    // When
    await connectOn(sources)(hexBytes(assetHub));

    // Then
    expect(sources.rpcChain).toHaveBeenCalledWith(assetHub.toLowerCase(), expect.any(Object));
    expect(sources.remoteChain).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, core connections to one chain share one transport', async () => {
    // Given
    const connect = connectOn(sources);

    // When
    await connect(hexBytes(people));
    await connect(hexBytes(people));

    // Then
    expect(sources.upstreams).toHaveLength(1);
    expect(must(sources.upstreams[0], 'upstream').opened).toBe(1);
  });

  it('As a dotli integrator, two core connections using the same request id each get only their own response', async () => {
    // Given
    const connect = connectOn(sources);
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));
    const request = { jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_genesisHash', params: [] };
    first.send(JSON.stringify(request));
    second.send(JSON.stringify(request));
    const upstream = must(sources.upstreams[0], 'upstream');
    const [toFirst, toSecond] = upstream.sent;

    // When
    upstream.emit({ jsonrpc: '2.0', id: must(must(toSecond, 'second request').id, 'id'), result: 'second' });
    upstream.emit({ jsonrpc: '2.0', id: must(must(toFirst, 'first request').id, 'id'), result: 'first' });

    // Then
    const firstResponses = first.responses()[Symbol.asyncIterator]();
    const secondResponses = second.responses()[Symbol.asyncIterator]();
    expect(JSON.parse(yielded(await firstResponses.next()))).toEqual({
      jsonrpc: '2.0',
      id: 'truapi:1',
      result: 'first',
    });
    expect(JSON.parse(yielded(await secondResponses.next()))).toEqual({
      jsonrpc: '2.0',
      id: 'truapi:1',
      result: 'second',
    });
    first.close();
    second.close();
  });

  it('As a dotli integrator, a halted chain transport leaves the core connection stream open', async () => {
    // Given
    const connection = await connectOn(sources)(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    const pending = responses.next();

    // When
    must(sources.upstreams[0], 'upstream').halt();
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));
    const rebuilt = must(sources.upstreams[1], 'rebuilt upstream');
    rebuilt.emit({ jsonrpc: '2.0', id: must(must(rebuilt.sent[0], 'request').id, 'id'), result: 'People' });

    // Then
    expect(JSON.parse(yielded(await pending))).toEqual({ jsonrpc: '2.0', id: 'truapi:2', result: 'People' });
    connection.close();
  });

  it('As a dotli integrator, a lease that halts before it is handed over is not kept', async () => {
    // Given: a pool whose first lease halts while it is being taken.
    const live = { send: vi.fn<JsonRpcConnection['send']>(), disconnect: vi.fn<() => void>() };
    const dead = { send: vi.fn<JsonRpcConnection['send']>(), disconnect: vi.fn<() => void>() };
    let leases = 0;
    const provider: LeaseProvider = (_onMessage, onHalt) => {
      leases += 1;
      if (leases === 1) {
        onHalt?.(new Error('chain died while connecting'));
        return dead;
      }
      return live;
    };
    const pool = { getLocalProvider: () => provider, status: () => 'disconnected' } as unknown as ChainPool;
    const connection = await createChainConnect(pool, sources)(hexBytes(people));

    // When
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));

    // Then: the request went out on a new lease, not the dead one.
    expect(dead.send).not.toHaveBeenCalled();
    expect(live.send).toHaveBeenCalledTimes(1);
    connection.close();
    expect(live.disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, a request after a halt that no new transport can serve is answered at once', async () => {
    // Given
    const connection = await connectOn(sources)(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(sources.upstreams[0], 'upstream').halt();
    sources.remoteChain.mockReturnValue(null);

    // When
    connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:2', method: 'chainSpec_v1_chainName', params: [] }));
    connection.send(JSON.stringify({ jsonrpc: '2.0', method: 'chainSpec_v1_chainName', params: [] }));

    // Then: the request gets the halted error, the notification nothing.
    expect(JSON.parse(yielded(await responses.next()))).toEqual({
      jsonrpc: '2.0',
      id: 'truapi:2',
      error: { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    connection.close();
    expect((await responses.next()).done).toBe(true);
  });

  it('As a dotli integrator, a halted chain transport still delivers the messages queued before it', async () => {
    // Given
    const connection = await connectOn(sources)(hexBytes(people));
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'truapi:1',
        method: 'transactionWatch_v1_submitAndWatch',
        params: ['0xdead'],
      }),
    );
    const upstream = must(sources.upstreams[0], 'upstream');
    upstream.emit({ jsonrpc: '2.0', id: must(must(upstream.sent[0], 'upstream submit').id, 'id'), result: 'watch-1' });

    // When: the light client dies, and the frame reports the status and the halt in one step
    upstream.halt();

    // Then
    const responses = connection.responses()[Symbol.asyncIterator]();
    const ack = JSON.parse(yielded(await responses.next())) as { id: unknown; result: unknown };
    expect(ack.id).toBe('truapi:1');
    expect(JSON.parse(yielded(await responses.next()))).toEqual({
      jsonrpc: '2.0',
      method: 'transactionWatch_v1_watchEvent',
      params: { subscription: ack.result, result: { event: 'dropped' } },
    });
    connection.close();
    expect((await responses.next()).done).toBe(true);
  });

  it('As a dotli integrator, a halted chain transport answers a request in flight', async () => {
    // Given
    const connection = await connectOn(sources)(hexBytes(people));
    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: 'truapi:9', method: 'chainHead_v1_header', params: ['tok', '0xabc'] }),
    );
    const upstream = must(sources.upstreams[0], 'upstream');
    expect(upstream.sent).toHaveLength(1);

    // When
    upstream.halt();

    // Then
    const responses = connection.responses()[Symbol.asyncIterator]();
    expect(JSON.parse(yielded(await responses.next()))).toMatchObject({
      id: 'truapi:9',
      error: { message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    connection.close();
    expect((await responses.next()).done).toBe(true);
  });

  it('As a dotli integrator, closing a halted core connection releases its lease once', async () => {
    // Given
    const pool = createHostChainPool({ ...sources, destroyDelay: 0 });
    const connection = await createChainConnect(pool, sources)(hexBytes(people));
    const upstream = must(sources.upstreams[0], 'upstream');
    upstream.halt();

    // When
    connection.close();
    connection.close();

    // Then: the transport is torn down once, and a new lease builds a fresh one
    expect(upstream.disconnect).toHaveBeenCalledTimes(1);
    await createChainConnect(pool, sources)(hexBytes(people));
    expect(sources.upstreams).toHaveLength(2);
    expect(upstream.disconnect).toHaveBeenCalledTimes(1);
  });

  describe('with the default pool settings', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('As a dotli user on a light client backend, a chain closes a minute after its last connection closes', async () => {
      // Given
      const connection = await connectOn(sources, {})(hexBytes(people));
      const upstream = must(sources.upstreams[0], 'upstream');

      // When
      connection.close();
      await vi.advanceTimersByTimeAsync(59_999);

      // Then
      expect(upstream.disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(upstream.disconnect).toHaveBeenCalledTimes(1);
    });

    it('As a dotli user on Trusted Providers, an RPC chain closes after its last connection closes', async () => {
      // Given
      sources.setBackend('rpc-gateway');
      const connection = await connectOn(sources, {})(hexBytes(people));
      const upstream = must(sources.upstreams[0], 'upstream');

      // When
      connection.close();
      await vi.advanceTimersByTimeAsync(120_000);

      // Then
      expect(upstream.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it('As a dotli integrator, closing a core connection releases its lease once', async () => {
    // Given
    const connection = await connectOn(sources)(hexBytes(people));

    // When
    connection.close();
    connection.close();

    // Then
    expect(must(sources.upstreams[0], 'upstream').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, a chain the RPC backend cannot reach is refused before any transport is built', () => {
    // Given
    sources.setBackend('rpc-gateway');
    sources.isRpcChainSupported.mockReturnValue(false);

    // When
    const connect = (): unknown => connectOn(sources)(hexBytes(people));

    // Then
    expect(connect).toThrow(`Unsupported RPC chain: ${people.toLowerCase()}`);
    expect(sources.rpcChain).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, a chain the protocol frame cannot serve is refused before any transport is built', () => {
    // Given
    sources.isRemoteChainConnectable.mockReturnValue(false);

    // When
    const connect = (): unknown => connectOn(sources)(hexBytes(people));

    // Then
    expect(connect).toThrow(`Unsupported smoldot chain: ${people.toLowerCase()}`);
    expect(sources.remoteChain).not.toHaveBeenCalled();
  });

  it("As a dotli user on Trusted Providers, name resolution leases the pool's one Asset Hub transport", () => {
    // Given
    sources.setBackend('rpc-gateway');
    const pool = createHostChainPool({ ...sources, destroyDelay: 0 });
    const received: JsonRpcMessage[] = [];

    // When
    const first = hostAssetHubProvider(pool)(message => received.push(message));
    const second = hostAssetHubProvider(pool)(message => received.push(message));

    // Then
    expect(sources.rpcChain).toHaveBeenCalledWith(assetHub.toLowerCase(), expect.any(Object));
    expect(sources.upstreams).toHaveLength(1);
    expect(must(sources.upstreams[0], 'upstream').opened).toBe(1);
    first.disconnect();
    second.disconnect();
  });
});

// The host page's chain pool end to end (Chain.ts, pool, broker, backend transport), with remote connections faked.

interface RemoteConnection {
  genesisHash: string;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  halt: (reason: RemoteChainHalt) => void;
  disconnect: Mock<() => void>;
}

describe('host chain pool on a light client backend', () => {
  let people: string;
  let assetHub: string;
  let remotes: RemoteConnection[];
  // How each new remote connection fares. `chain`: the chain halts at once.
  let refuse: 'none' | 'chain';
  let remoteChain: Mock<(genesisHash: string) => RemoteChainProvider | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    people = getActiveServicesConfig().people.genesis;
    assetHub = getActiveServicesConfig().assethub.genesis;
    remotes = [];
    refuse = 'none';
    remoteChain = vi.fn<(genesisHash: string) => RemoteChainProvider | null>(genesisHash => (onMessage, onHalt) => {
      const remote: RemoteConnection = {
        genesisHash,
        sent: [],
        emit: onMessage,
        halt: reason => onHalt?.(reason),
        disconnect: vi.fn<() => void>(),
      };
      remotes.push(remote);
      if (refuse === 'chain') {
        queueMicrotask(() => {
          remote.halt('chain');
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
    vi.restoreAllMocks();
  });

  const ask = (connection: { send: (request: string) => void }, id: string): void => {
    connection.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'chainSpec_v1_chainName', params: [] }));
  };

  it("As a dotli user, a block bar shares the products' connection to the protocol frame", async () => {
    // Given
    const pool = createHostChainPool({ remoteChain });
    const connect = createChainConnect(pool);
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));

    // When
    const bar = must(hostChainProvider(people, pool), 'provider')(() => undefined);

    // Then
    expect(remoteChain).toHaveBeenCalledTimes(1);
    expect(remotes).toHaveLength(1);
    first.close();
    second.close();
    bar.disconnect();
  });

  it.each(['chain', 'frame'] as const)(
    'As a dotli user, a %s halt of the connection to the protocol frame reaches a block bar with its reason',
    async reason => {
      // Given
      const pool = createHostChainPool({ remoteChain });
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
    const provider = hostChainProvider(`0x${'00'.repeat(32)}`, createHostChainPool({ remoteChain }));

    // Then
    expect(provider).toBeNull();
    expect(remoteChain).not.toHaveBeenCalled();
  });

  it.each(['chain', 'frame'] as const)(
    "As a dotli user, a product's chain connection outlives a %s halt: what was queued arrives, and its next request opens a fresh connection to the frame",
    async reason => {
      // Given: a product request answered by the frame, not yet read.
      const connection = await createChainConnect(createHostChainPool({ remoteChain }))(hexBytes(people));
      const responses = connection.responses()[Symbol.asyncIterator]();
      connection.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));
      const first = must(remotes[0], 'first remote');
      first.emit({ jsonrpc: '2.0', id: must(must(first.sent[0], 'request').id, 'id'), result: 'People' });

      // When: the connection to the frame halts, then the product asks again.
      first.halt(reason);
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

  it('As a product whose chain halted with the frame, my next request while the frame is down boots it and waits instead of failing at once', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool({ remoteChain }))(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(remotes[0], 'first remote').halt('frame');

    // When: the product asks, and its papi client retries while the frame boots.
    ask(connection, 'truapi:1');
    for (let i = 2; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(250);
      ask(connection, `truapi:${String(i)}`);
    }

    // Then: one new connection takes every request and waits on the boot, and the first answer comes once it is up.
    expect(remotes).toHaveLength(2);
    const waiting = must(remotes[1], 'People on the booting frame');
    expect(waiting.sent).toHaveLength(5);
    waiting.emit({ jsonrpc: '2.0', id: must(must(waiting.sent[0], 'request').id, 'id'), result: 'People' });
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', result: 'People' });
    connection.close();
  });

  it('As a dotli user, a re-lease after a frame halt that finds no transport answers the request at once', async () => {
    // Given: a frame halt, the frame back, and no transport to be had.
    const connection = await createChainConnect(createHostChainPool({ remoteChain }))(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(remotes[0], 'first remote').halt('frame');
    remoteChain.mockReturnValue(null);

    // When
    ask(connection, 'truapi:1');

    // Then
    const halted = { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' };
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', error: halted });
    expect(remoteChain).toHaveBeenCalledTimes(2);
    connection.close();
  });

  it('As a dotli user, a product retrying on a chain that halts right after each rebuild rebuilds it only as the backoff allows', async () => {
    // Given: the chain halted, and every rebuild of it halts at once.
    const connection = await createChainConnect(createHostChainPool({ remoteChain }))(hexBytes(people));
    must(remotes[0], 'first remote').halt('chain');
    refuse = 'chain';

    // When: the product's papi client retries every 250 ms for two minutes.
    for (let i = 0; i < 480; i++) {
      ask(connection, `truapi:${String(i)}`);
      await vi.advanceTimersByTimeAsync(250);
    }

    // Then: the chain is rebuilt at once, then at 1, 3, 7, 15, 31, 61 and
    // 91 s, the chain backoff's windows, and no more.
    expect(remotes).toHaveLength(9);
    connection.close();
  });

  it('As a dotli user, a request on a chain whose backoff is shut is answered at once', async () => {
    // Given: the chain halted, was rebuilt at once, and halted again.
    const connection = await createChainConnect(createHostChainPool({ remoteChain }))(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    must(remotes[0], 'first remote').halt('chain');
    ask(connection, 'truapi:1');
    expect(remotes).toHaveLength(2);
    must(remotes[1], 'second remote').halt('chain');

    // When
    ask(connection, 'truapi:2');
    connection.send(JSON.stringify({ jsonrpc: '2.0', method: 'chainSpec_v1_chainName', params: [] }));

    // Then: the request gets the halted error, the notification nothing, and
    // the chain is not rebuilt.
    const halted = { code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' };
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', error: halted });
    expect(JSON.parse(yielded(await responses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:2', error: halted });
    expect(remotes).toHaveLength(2);
    connection.close();
  });

  it('As a dotli user, a chain that halts again within 30 s of its rebuild is rebuilt 1 s later', async () => {
    // Given: the chain halted, was rebuilt at once, and the rebuild lived 10 s.
    const connection = await createChainConnect(createHostChainPool({ remoteChain }))(hexBytes(people));
    must(remotes[0], 'first remote').halt('chain');
    ask(connection, 'truapi:1');
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);

    // When
    must(remotes[1], 'second remote').halt('chain');

    // Then
    ask(connection, 'truapi:2');
    await vi.advanceTimersByTimeAsync(999);
    ask(connection, 'truapi:3');
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    ask(connection, 'truapi:4');
    expect(remotes).toHaveLength(3);
    connection.close();
  });

  it('As a dotli user, a chain whose rebuild lived past 30 s is rebuilt at once after its next halt', async () => {
    // Given: the chain halted twice in a row, so its backoff has grown, and
    // the rebuild after that lived 31 s.
    const connection = await createChainConnect(createHostChainPool({ remoteChain }))(hexBytes(people));
    must(remotes[0], 'first remote').halt('chain');
    ask(connection, 'truapi:1');
    must(remotes[1], 'second remote').halt('chain');
    await vi.advanceTimersByTimeAsync(1_000);
    ask(connection, 'truapi:2');
    expect(remotes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(31_000);

    // When
    must(remotes[2], 'third remote').halt('chain');
    ask(connection, 'truapi:3');

    // Then: rebuilt at once, and a halt right after waits 1 s again.
    expect(remotes).toHaveLength(4);
    must(remotes[3], 'fourth remote').halt('chain');
    await vi.advanceTimersByTimeAsync(999);
    ask(connection, 'truapi:4');
    expect(remotes).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    ask(connection, 'truapi:5');
    expect(remotes).toHaveLength(5);
    connection.close();
  });

  it("As a dotli user, one chain's backoff does not hold back another chain", async () => {
    // Given: People halted, was rebuilt at once, and halted again.
    const connect = createChainConnect(createHostChainPool({ remoteChain }));
    const onPeople = await connect(hexBytes(people));
    const onAssetHub = await connect(hexBytes(assetHub));
    const peopleRemotes = (): RemoteConnection[] => remotes.filter(r => r.genesisHash === people.toLowerCase());
    const assetHubRemotes = (): RemoteConnection[] => remotes.filter(r => r.genesisHash === assetHub.toLowerCase());
    must(peopleRemotes()[0], 'People').halt('chain');
    ask(onPeople, 'p:1');
    must(peopleRemotes()[1], 'rebuilt People').halt('chain');

    // When: Asset Hub halts, and both products ask.
    must(assetHubRemotes()[0], 'Asset Hub').halt('chain');
    ask(onAssetHub, 'a:1');
    ask(onPeople, 'p:2');

    // Then: Asset Hub is rebuilt at once, People waits for its own window.
    expect(assetHubRemotes()).toHaveLength(2);
    expect(peopleRemotes()).toHaveLength(2);
    onPeople.close();
    onAssetHub.close();
  });

  it('As a dotli user, two products after a chain halt share its rebuild, and wait together when it halts again', async () => {
    // Given
    const connect = createChainConnect(createHostChainPool({ remoteChain }));
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));
    must(remotes[0], 'first remote').halt('chain');

    // When: both products ask.
    ask(first, 'a:1');
    ask(second, 'b:1');

    // Then: the first rebuilt the chain, and the second's request rides on it.
    expect(remotes).toHaveLength(2);
    expect(must(remotes[1], 'second remote').sent).toHaveLength(2);

    // When: the rebuild halts at once, and both ask again.
    must(remotes[1], 'second remote').halt('chain');
    ask(first, 'a:2');
    ask(second, 'b:2');

    // Then: neither rebuilds it before the window opens.
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    ask(second, 'b:3');
    ask(first, 'a:3');
    expect(remotes).toHaveLength(3);
    expect(must(remotes[2], 'third remote').sent).toHaveLength(2);
    first.close();
    second.close();
  });

  it('As a dotli user, a block bar after a halt opens a fresh connection to the frame', () => {
    // Given
    const pool = createHostChainPool({ remoteChain });
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
    const connect = createChainConnect(createHostChainPool({ remoteChain }));
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

  it('As the network panel, a lease on the host pool reports its chain held without the panel holding it', () => {
    // Given a pool the panel watches, as the page's is
    const reported: ChainActivity[] = [];
    const pool = createHostChainPool({ remoteChain });
    watchHostChains({ onActivity: activity => reported.push(activity), onBestBlock: () => undefined }, pool);
    const consumers = (): number | undefined =>
      reported.findLast(activity => activity.genesisHash === people.toLowerCase())?.consumers;
    expect(consumers()).toBeUndefined();

    // When
    const connection = must(hostChainProvider(people, pool), 'provider')(() => undefined);

    // Then
    expect(consumers()).toBe(1);

    // When
    connection.disconnect();

    // Then
    expect(consumers()).toBe(0);
  });
});

describe('host chain pool over Trusted Providers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a dotli user on Trusted Providers, a block bar and a product's connection share one socket", async () => {
    // Given
    const people = getActiveServicesConfig().people.genesis;
    const pool = createHostChainPool({ rpcChain: fakeSocketChain });
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
    product.close();
    bar.disconnect();
  });
});

// End to end through the real host path (Chain.ts, the chain pool and broker, the replaying RPC transport) over a
// fake server.

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
    FakeWebSocket.instances = [];
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a chat user on Trusted Providers, a statement subscription keeps delivering after 120 seconds of quiet', async () => {
    // Given: a core connection to the People chain and an acknowledged subscription.
    const people = getActiveServicesConfig().people.genesis;
    const connection = await createChainConnect(createHostChainPool({ destroyDelay: 0, rpcChain: fakeSocketChain }))(
      hexBytes(people),
    );
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
