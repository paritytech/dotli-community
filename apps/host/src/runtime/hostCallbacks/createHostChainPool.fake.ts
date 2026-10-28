// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import type { Backend } from '@dotli/config';
import type { ChainTransportHooks, RemoteChainHalt } from '@dotli/chains';
import type { ProtocolStatus } from '@dotli/protocol';
import { createCoreRpcChainProvider } from '@dotli/chains';
import { FakeWebSocket } from '@dotli/chains/testing';
import type { RemoteChainFactory } from './createFrameChainTransport.js';
import type { FrameStatusSource, HostChainSources } from './createHostChainPool.js';

/** One transport a fake source built, as the test drives it. */
export type Upstream = {
  /** The requests sent over it, in order. */
  sent: JsonRpcRequest[];
  /** Delivers a message to its lease. */
  emit: (message: JsonRpcMessage) => void;
  /** The chain dies, as its transport reports it. */
  halt: () => void;
  /** Called when its lease closes it. */
  disconnect: Mock<() => void>;
  /** How many leases opened it. */
  opened: number;
};

/** One remote connection to the protocol frame, as the test drives it. */
export type RemoteConnection = {
  /** The chain it connects to. */
  genesisHash: string;
  /** The requests sent over it, in order. */
  sent: JsonRpcRequest[];
  /** Delivers a message to its lease. */
  emit: (message: JsonRpcMessage) => void;
  /** Halts it for `reason`, as the frame reports it. */
  halt: (reason: RemoteChainHalt) => void;
  /** Called when its lease closes it. */
  disconnect: Mock<() => void>;
};

export type FakeHostChainSources = ReturnType<typeof createFakeHostChainSources>;

export type FakeRemoteChains = ReturnType<typeof createFakeRemoteChains>;

/** Both backends' chains, recording each transport built in `upstreams`, on the backend a test sets. */
export function createFakeHostChainSources() {
  const upstreams: Upstream[] = [];
  let backend: Backend = 'smoldot-shared-worker';
  return {
    /** Every transport built, in order. */
    upstreams,
    /** Switches the backend the sources report. */
    setBackend(next: Backend): void {
      backend = next;
    },
    /** The backend last set, the shared worker light client at first. */
    backend: (): Backend => backend,
    /** Serves every chain unless a test says otherwise. */
    isRemoteChainConnectable: vi.fn<HostChainSources['isRemoteChainConnectable']>(() => true),
    /** Serves every chain unless a test says otherwise. */
    isRpcChainSupported: vi.fn<HostChainSources['isRpcChainSupported']>(() => true),
    /** Builds a light client transport whose `halt` reports a chain halt. */
    createRemoteChain: vi.fn<HostChainSources['createRemoteChain']>(() => {
      const upstream = createUpstream();
      upstreams.push(upstream);
      return (onMessage, onHalt) => {
        upstream.halt = () => {
          onHalt?.('chain');
        };
        return connectUpstream(upstream, onMessage);
      };
    }),
    /** Builds a Trusted Providers transport whose `halt` reports the socket gone. */
    createRpcChain: vi.fn<HostChainSources['createRpcChain']>((_genesisHash, hooks) => {
      const upstream = createUpstream();
      upstream.halt = () => {
        hooks.onStatus('disconnected');
        hooks.onHalt(new Error('socket gone'));
      };
      upstreams.push(upstream);
      return onMessage => connectUpstream(upstream, onMessage);
    }),
  };
}

/** Remote connections to a protocol frame whose status and refusals the test sets. */
export function createFakeRemoteChains() {
  const remotes: RemoteConnection[] = [];
  let refusal: 'none' | RemoteChainHalt = 'none';
  let frameStatus: ProtocolStatus = 'ready';
  const frame: FrameStatusSource = { getProtocolStatus: () => frameStatus };
  return {
    /** Every remote connection opened, in order. */
    remotes,
    /** The light client backends' source, recording each connection in `remotes`. */
    createRemoteChain: vi.fn<RemoteChainFactory>(genesisHash => (onMessage, onHalt) => {
      const remote: RemoteConnection = {
        genesisHash,
        sent: [],
        emit: onMessage,
        halt: reason => onHalt?.(reason),
        disconnect: vi.fn<() => void>(),
      };
      remotes.push(remote);
      if (refusal !== 'none') {
        const reason = refusal;
        queueMicrotask(() => {
          remote.halt(reason);
        });
      }
      const connection: JsonRpcConnection = {
        send: message => remote.sent.push(message),
        disconnect: remote.disconnect,
      };
      return connection;
    }),
    /** The protocol frame, reporting the status last set, `'ready'` at first. */
    frame,
    /** Makes each new remote connection halt at once for `reason`, or stay up for `'none'`. */
    setRefusal(reason: 'none' | RemoteChainHalt): void {
      refusal = reason;
    },
    /** Sets the status the frame reports. */
    setFrameStatus(status: ProtocolStatus): void {
      frameStatus = status;
    },
  };
}

/** Trusted Providers' sockets, over the fake server. */
export function createFakeSocketChain(
  genesisHash: string,
  hooks: ChainTransportHooks,
): ReturnType<HostChainSources['createRpcChain']> {
  // The fake socket implements the members the transport reaches, not the whole browser WebSocket.
  return createCoreRpcChainProvider(genesisHash, {
    hooks,
    WebSocketBase: FakeWebSocket as unknown as typeof WebSocket,
  });
}

function createUpstream(): Upstream {
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
