// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { ChainTransportHooks, ConnectionStatus } from '@dotli/resolver';
import { ChainHaltError, type RemoteChainHalt, type RemoteChainProvider } from '@dotli/protocol';
import type * as ClientModule from '../../protocol/src/client.js';
import { createFrameChainTransport } from '../src/host-callbacks/frame-transport.js';
import { must } from './support.js';

interface RemoteConnection {
  onHalt: ((reason: RemoteChainHalt) => void) | undefined;
  send: Mock<JsonRpcConnection['send']>;
  disconnect: Mock<() => void>;
}

const mocks = vi.hoisted(() => ({
  createRemoteChainProvider: vi.fn<(genesisHash: string) => RemoteChainProvider | null>(),
}));

vi.mock('../../protocol/src/client.js', async importOriginal => ({
  ...(await importOriginal<typeof ClientModule>()),
  createRemoteChainProvider: mocks.createRemoteChainProvider,
}));

const GENESIS = `0x${'ab'.repeat(32)}`;

describe('createFrameChainTransport', () => {
  let connections: RemoteConnection[];
  let events: string[];
  let hooks: ChainTransportHooks;

  beforeEach(() => {
    connections = [];
    events = [];
    hooks = {
      onStatus: (status: ConnectionStatus) => events.push(`status:${status}`),
      onHalt: (error?: unknown) => {
        events.push(error instanceof ChainHaltError ? `halt:${error.reason}` : `halt:${String(error)}`);
      },
    };
    mocks.createRemoteChainProvider.mockReset().mockImplementation(() => (_onMessage, onHalt) => {
      const connection: RemoteConnection = {
        onHalt,
        send: vi.fn<JsonRpcConnection['send']>(),
        disconnect: vi.fn<() => void>(),
      };
      connections.push(connection);
      return connection;
    });
  });

  it('As a dotli integrator, a frame connection reports connecting, then connected', () => {
    // Given
    const transport = must(createFrameChainTransport(GENESIS, hooks), 'transport');

    // When
    transport(() => undefined);

    // Then
    expect(mocks.createRemoteChainProvider).toHaveBeenCalledWith(GENESIS);
    expect(events).toEqual(['status:connecting', 'status:connected']);
  });

  it.each(['chain', 'frame'] as const)(
    'As a dotli integrator, a %s halt of the frame connection reaches the pool as a disconnect, then a halt that carries its reason',
    reason => {
      // Given
      const transport = must(createFrameChainTransport(GENESIS, hooks), 'transport');
      transport(() => undefined);
      events = [];

      // When
      must(must(connections[0], 'connection').onHalt, 'onHalt')(reason);

      // Then
      expect(events).toEqual(['status:disconnected', `halt:${reason}`]);
    },
  );

  it('As a dotli integrator, a frame connection passes its sends and its disconnect through', () => {
    // Given
    const transport = must(createFrameChainTransport(GENESIS, hooks), 'transport');
    const connection = transport(() => undefined);
    const message: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] };

    // When
    connection.send(message);
    connection.disconnect();

    // Then
    const remote = must(connections[0], 'connection');
    expect(remote.send).toHaveBeenCalledWith(message);
    expect(remote.disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, a chain the frame cannot serve has no transport', () => {
    // Given
    mocks.createRemoteChainProvider.mockReturnValue(null);

    // When
    const transport = createFrameChainTransport(GENESIS, hooks);

    // Then
    expect(transport).toBeNull();
    expect(events).toEqual([]);
  });
});
