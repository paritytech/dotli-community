// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import type { ChainTransportHooks } from '@dotli/resolver';
import { createChainConnect, createHostChainPool } from '../src/host-callbacks/Chain.js';
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
  createSmoldotChainProvider: vi.fn(),
  createCoreRpcChainProvider: vi.fn(),
  isSmoldotChainSupported: vi.fn(),
  isCoreRpcChainSupported: vi.fn(),
}));

vi.mock('../../config/src/mode.js', () => ({
  getBackend: () => mocks.backend,
}));

vi.mock('../../resolver/src/provider.js', () => ({
  createChainProvider: mocks.createSmoldotChainProvider,
  isChainSupported: mocks.isSmoldotChainSupported,
}));

vi.mock('../../resolver/src/rpc-chain.js', () => ({
  createCoreRpcChainProvider: mocks.createCoreRpcChainProvider,
  isCoreRpcChainSupported: mocks.isCoreRpcChainSupported,
}));

/** A transport factory that records each transport it builds. */
function recordingTransport(_genesisHash: string, hooks: ChainTransportHooks): (onMessage: (message: JsonRpcMessage) => void) => JsonRpcConnection {
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
    mocks.createSmoldotChainProvider.mockImplementation(recordingTransport);
    mocks.createCoreRpcChainProvider.mockImplementation(recordingTransport);
    mocks.isSmoldotChainSupported.mockReturnValue(true);
    mocks.isCoreRpcChainSupported.mockReturnValue(true);
  });

  it('As a dotli integrator, the host routes chain connections through the selected smoldot backend', async () => {
    // When
    await createChainConnect(createHostChainPool(0))(hexBytes(people));

    // Then
    expect(mocks.createSmoldotChainProvider).toHaveBeenCalledWith(
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
    expect(mocks.createSmoldotChainProvider).not.toHaveBeenCalled();
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
    expect(JSON.parse(yielded(await firstResponses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', result: 'first' });
    expect(JSON.parse(yielded(await secondResponses.next()))).toEqual({ jsonrpc: '2.0', id: 'truapi:1', result: 'second' });
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
});
