// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page's chain pool end to end: Chain.ts, the pool and broker, and
// the backend's transport, with the protocol frame's remote connections faked.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, setBackend } from '@dotli/config';
import type { RemoteChainHalt, RemoteChainProvider } from '@dotli/protocol';
import type * as ClientModule from '../../protocol/src/client.js';
import { createChainConnect, createHostChainPool } from '../src/host-callbacks/Chain.js';
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
