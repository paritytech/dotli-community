// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page runs no light client, so chains go over one remote connection to the protocol frame.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainTransportHooks } from '@dotli/chains';
import { ChainHaltError } from '@dotli/chains';
import { getProtocolClient, type RemoteChainProvider } from '@dotli/protocol';

/** Opens remote connections to one chain through the protocol frame, or null for a chain it cannot serve. */
export type RemoteChainFactory = (genesisHash: string) => RemoteChainProvider | null;

type Params = {
  /** Where the remote connections come from. The page's protocol client by default. */
  createRemoteChain?: RemoteChainFactory;
};

/**
 * A halt of the remote connection reaches the pool as `disconnected`, then as a `ChainHaltError`. Returns null for a
 * chain the protocol frame cannot serve.
 */
export function createFrameChainTransport(
  genesisHash: string,
  hooks: ChainTransportHooks,
  { createRemoteChain = createPageRemoteChain }: Params = {},
): JsonRpcProvider | null {
  const remote = createRemoteChain(genesisHash);
  if (remote === null) {
    return null;
  }
  return createRemoteTransport(remote, hooks);
}

/**
 * Opens the page's remote connections to one chain through its protocol client. Returns null for a chain the frame
 * cannot serve. Never throws.
 */
export function createPageRemoteChain(genesisHash: string): RemoteChainProvider | null {
  return getProtocolClient().chains.createProvider(genesisHash);
}

function createRemoteTransport(remote: RemoteChainProvider, hooks: ChainTransportHooks): JsonRpcProvider {
  function connectRemote(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
    hooks.onStatus('connecting');
    const connection = remote(onMessage, reason => {
      hooks.onStatus('disconnected');
      hooks.onHalt(new ChainHaltError(reason));
    });
    // `connected` shows once the connection is opened, which may be while the frame still boots. A refusal arrives as
    // a halt.
    hooks.onStatus('connected');
    return connection;
  }

  return connectRemote;
}
