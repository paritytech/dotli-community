// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { log } from '@dotli/shared';
import type { ChainTransportHooks } from '@dotli/resolver';
import type * as ClientModule from '../../protocol/src/client.js';
import { createChainConnect, createHostChainPool, hostAssetHubProvider } from '../src/host-callbacks/Chain.js';
import { hexBytes, must, yielded } from './support.js';

interface Upstream {
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  disconnect: Mock<() => void>;
  hooks: ChainTransportHooks;
  opened: number;
}

const mocks = vi.hoisted(() => ({
  backend: 'smoldot-shared-worker',
  upstreams: [] as Upstream[],
  createFrameChainTransport: vi.fn(),
  createCoreRpcChainProvider: vi.fn(),
  isRemoteChainConnectable: vi.fn(),
  isCoreRpcChainSupported: vi.fn(),
}));

vi.mock('../../config/src/mode.js', () => ({
  getBackend: () => mocks.backend,
}));

vi.mock('../src/host-callbacks/frame-transport.js', () => ({
  createFrameChainTransport: mocks.createFrameChainTransport,
}));

vi.mock('../../protocol/src/client.js', async importOriginal => ({
  ...(await importOriginal<typeof ClientModule>()),
  isRemoteChainConnectable: mocks.isRemoteChainConnectable,
}));

vi.mock('../../resolver/src/rpc-chain.js', () => ({
  createCoreRpcChainProvider: mocks.createCoreRpcChainProvider,
  isCoreRpcChainSupported: mocks.isCoreRpcChainSupported,
}));

/** A transport factory that records each transport it builds. */
function recordingTransport(
  _genesisHash: string,
  hooks: ChainTransportHooks,
): (onMessage: (message: JsonRpcMessage) => void) => JsonRpcConnection {
  let listener: ((message: JsonRpcMessage) => void) | null = null;
  const upstream: Upstream = {
    sent: [],
    emit(message) {
      listener?.(message);
    },
    disconnect: vi.fn<() => void>(),
    hooks,
    opened: 0,
  };
  mocks.upstreams.push(upstream);
  return onMessage => {
    listener = onMessage;
    upstream.opened += 1;
    return {
      send(message) {
        upstream.sent.push(message);
      },
      disconnect: upstream.disconnect,
    };
  };
}

describe('createChainConnect', () => {
  const people = getActiveServicesConfig().people.genesis;
  const assetHub = getActiveServicesConfig().assethub.genesis;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backend = 'smoldot-shared-worker';
    mocks.upstreams = [];
    mocks.createFrameChainTransport.mockImplementation(recordingTransport);
    mocks.createCoreRpcChainProvider.mockImplementation(recordingTransport);
    mocks.isRemoteChainConnectable.mockReturnValue(true);
    mocks.isCoreRpcChainSupported.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("As a dotli integrator, the host routes chain connections on a light client backend through the protocol frame's light client", async () => {
    // When
    await createChainConnect(createHostChainPool(0))(hexBytes(people));

    // Then
    expect(mocks.createFrameChainTransport).toHaveBeenCalledWith(
      people.toLowerCase(),
      expect.objectContaining({ onStatus: expect.any(Function) as unknown, onHalt: expect.any(Function) as unknown }),
    );
    expect(mocks.createCoreRpcChainProvider).not.toHaveBeenCalled();
  });

  it('As a dotli user on Trusted Providers, the host routes chain connections through the core RPC transport', async () => {
    // Given
    mocks.backend = 'rpc-gateway';

    // When
    await createChainConnect(createHostChainPool(0))(hexBytes(assetHub));

    // Then
    expect(mocks.createCoreRpcChainProvider).toHaveBeenCalledWith(assetHub.toLowerCase(), expect.any(Object));
    expect(mocks.createFrameChainTransport).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, core connections to one chain share one transport', async () => {
    // Given
    const connect = createChainConnect(createHostChainPool(0));

    // When
    await connect(hexBytes(people));
    await connect(hexBytes(people));

    // Then
    expect(mocks.upstreams).toHaveLength(1);
    expect(must(mocks.upstreams[0], 'upstream').opened).toBe(1);
  });

  it('As a dotli integrator, two core connections using the same request id each get only their own response', async () => {
    // Given
    const connect = createChainConnect(createHostChainPool(0));
    const first = await connect(hexBytes(people));
    const second = await connect(hexBytes(people));
    const request = { jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_genesisHash', params: [] };
    first.send(JSON.stringify(request));
    second.send(JSON.stringify(request));
    const upstream = must(mocks.upstreams[0], 'upstream');
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

  it('As a dotli integrator, a halted chain transport ends the core connection stream', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));
    const responses = connection.responses()[Symbol.asyncIterator]();
    const pending = responses.next();

    // When
    must(mocks.upstreams[0], 'upstream').hooks.onHalt(new Error('chain stopped responding'));

    // Then
    expect((await pending).done).toBe(true);
  });

  it('As a dotli integrator, a halted chain transport still delivers the messages queued before it, then ends the stream', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));
    connection.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'truapi:1',
        method: 'transactionWatch_v1_submitAndWatch',
        params: ['0xdead'],
      }),
    );
    const upstream = must(mocks.upstreams[0], 'upstream');
    upstream.emit({ jsonrpc: '2.0', id: must(must(upstream.sent[0], 'upstream submit').id, 'id'), result: 'watch-1' });

    // When: smoldot dies, and its provider reports the status and the halt in one step
    upstream.hooks.onStatus('disconnected');
    upstream.hooks.onHalt(new Error('smoldot died'));

    // Then
    const responses = connection.responses()[Symbol.asyncIterator]();
    const ack = JSON.parse(yielded(await responses.next())) as { id: unknown; result: unknown };
    expect(ack.id).toBe('truapi:1');
    expect(JSON.parse(yielded(await responses.next()))).toEqual({
      jsonrpc: '2.0',
      method: 'transactionWatch_v1_watchEvent',
      params: { subscription: ack.result, result: { event: 'dropped' } },
    });
    expect((await responses.next()).done).toBe(true);
  });

  it('As a dotli integrator, a halted chain transport answers a request in flight before the stream ends', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));
    connection.send(
      JSON.stringify({ jsonrpc: '2.0', id: 'truapi:9', method: 'chainHead_v1_header', params: ['tok', '0xabc'] }),
    );
    const upstream = must(mocks.upstreams[0], 'upstream');
    expect(upstream.sent).toHaveLength(1);

    // When
    upstream.hooks.onStatus('disconnected');
    upstream.hooks.onHalt(new Error('smoldot died'));

    // Then
    const responses = connection.responses()[Symbol.asyncIterator]();
    expect(JSON.parse(yielded(await responses.next()))).toMatchObject({
      id: 'truapi:9',
      error: { message: 'Chain transport halted', data: 'dotli:chain-halted' },
    });
    expect((await responses.next()).done).toBe(true);
  });

  it('As a dotli integrator, closing a halted core connection releases its lease once', async () => {
    // Given
    const pool = createHostChainPool(0);
    const connection = await createChainConnect(pool)(hexBytes(people));
    const upstream = must(mocks.upstreams[0], 'upstream');
    upstream.hooks.onHalt(new Error('chain stopped responding'));

    // When
    connection.close();
    connection.close();

    // Then: the transport is torn down once, and a new lease builds a fresh one
    expect(upstream.disconnect).toHaveBeenCalledTimes(1);
    await createChainConnect(pool)(hexBytes(people));
    expect(mocks.upstreams).toHaveLength(2);
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
      const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
      const upstream = must(mocks.upstreams[0], 'upstream');

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
      mocks.backend = 'rpc-gateway';
      const connection = await createChainConnect(createHostChainPool())(hexBytes(people));
      const upstream = must(mocks.upstreams[0], 'upstream');

      // When
      connection.close();
      await vi.advanceTimersByTimeAsync(120_000);

      // Then
      expect(upstream.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it('As a dotli integrator, closing a core connection releases its lease once', async () => {
    // Given
    const connection = await createChainConnect(createHostChainPool(0))(hexBytes(people));

    // When
    connection.close();
    connection.close();

    // Then
    expect(must(mocks.upstreams[0], 'upstream').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, a chain the RPC backend cannot reach is refused before any transport is built', () => {
    // Given
    mocks.backend = 'rpc-gateway';
    mocks.isCoreRpcChainSupported.mockReturnValue(false);

    // When
    const connect = (): unknown => createChainConnect(createHostChainPool(0))(hexBytes(people));

    // Then
    expect(connect).toThrow(`Unsupported RPC chain: ${people.toLowerCase()}`);
    expect(mocks.createCoreRpcChainProvider).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, a chain the protocol frame cannot serve is refused before any transport is built', () => {
    // Given
    mocks.isRemoteChainConnectable.mockReturnValue(false);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    // When
    const connect = (): unknown => createChainConnect(createHostChainPool(0))(hexBytes(people));

    // Then
    expect(connect).toThrow(`Unsupported smoldot chain: ${people.toLowerCase()}`);
    expect(mocks.createFrameChainTransport).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      `[dot.li truapi-chain] smoldot backend doesn't support ${people.toLowerCase()}; product call will fail`,
    );
  });

  it("As a dotli user on Trusted Providers, name resolution leases the pool's one Asset Hub transport", () => {
    // Given
    mocks.backend = 'rpc-gateway';
    const received: JsonRpcMessage[] = [];

    // When
    const first = hostAssetHubProvider()(message => received.push(message));
    const second = hostAssetHubProvider()(message => received.push(message));

    // Then
    expect(mocks.createCoreRpcChainProvider).toHaveBeenCalledWith(assetHub.toLowerCase(), expect.any(Object));
    expect(mocks.upstreams).toHaveLength(1);
    expect(must(mocks.upstreams[0], 'upstream').opened).toBe(1);
    first.disconnect();
    second.disconnect();
  });
});
