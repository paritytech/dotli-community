// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { ChainHaltError, type ChainTransportHooks, type ConnectionStatus, type RemoteChainHalt } from '@dotli/chains';
import type { RemoteChainProvider } from '@dotli/protocol';
import { createFrameChainTransport } from './createFrameChainTransport.js';
import { must } from '@dotli/shared/testing';

type RemoteConnection = {
  onHalt: ((reason: RemoteChainHalt) => void) | undefined;
  send: Mock<JsonRpcConnection['send']>;
  disconnect: Mock<() => void>;
};

const GENESIS = `0x${'ab'.repeat(32)}`;

describe('createFrameChainTransport', () => {
  let connections: RemoteConnection[];
  let events: string[];
  let hooks: ChainTransportHooks;
  let createRemoteChain: Mock<(genesisHash: string) => RemoteChainProvider | null>;

  beforeEach(() => {
    connections = [];
    events = [];
    hooks = {
      onStatus: (status: ConnectionStatus) => events.push(`status:${status}`),
      onHalt: (error?: unknown) => {
        events.push(error instanceof ChainHaltError ? `halt:${error.reason}` : `halt:${String(error)}`);
      },
    };
    createRemoteChain = vi.fn<(genesisHash: string) => RemoteChainProvider | null>(() => (_onMessage, onHalt) => {
      const connection: RemoteConnection = {
        onHalt,
        send: vi.fn<JsonRpcConnection['send']>(),
        disconnect: vi.fn<() => void>(),
      };
      connections.push(connection);
      return connection;
    });
  });

  it('As a dotli integrator, I connect to a chain over the frame and the connection reports connecting, then connected', () => {
    // Given
    const provider = must(createFrameChainTransport(GENESIS, hooks, { createRemoteChain }), 'transport').provider;

    // When
    provider(() => undefined);

    // Then
    expect(createRemoteChain).toHaveBeenCalledWith(GENESIS);
    expect(events).toEqual(['status:connecting', 'status:connected']);
  });

  it.each(['chain', 'frame'] as const)(
    'As a dotli integrator, I see a %s halt of the frame connection and the pool hears a disconnect, then a halt that carries its reason',
    reason => {
      // Given
      const provider = must(createFrameChainTransport(GENESIS, hooks, { createRemoteChain }), 'transport').provider;
      provider(() => undefined);
      events = [];

      // When
      must(must(connections[0], 'connection').onHalt, 'onHalt')(reason);

      // Then
      expect(events).toEqual(['status:disconnected', `halt:${reason}`]);
    },
  );

  it('As a dotli integrator, I ask for a chain the frame cannot serve and get no transport', () => {
    // Given
    createRemoteChain.mockReturnValue(null);

    // When
    const transport = createFrameChainTransport(GENESIS, hooks, { createRemoteChain });

    // Then
    expect(transport).toBeNull();
    expect(events).toEqual([]);
  });
});
