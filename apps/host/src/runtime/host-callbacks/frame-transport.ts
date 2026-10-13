// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page runs no light client, so chains go over one remote connection to the protocol frame.

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainTransportHooks } from '@dotli/chains';
import { ChainHaltError } from '@dotli/chains';
import { createRemoteChainProvider, type RemoteChainProvider } from '@dotli/protocol';

/** Opens remote connections to one chain through the protocol frame, or null for a chain it cannot serve. */
export type RemoteChainFactory = (genesisHash: string) => RemoteChainProvider | null;

/** A halt of the remote connection reaches the pool as `disconnected`, then as a `ChainHaltError`. */
export function createFrameChainTransport(
  genesisHash: string,
  hooks: ChainTransportHooks,
  remoteChain: RemoteChainFactory = createRemoteChainProvider,
): JsonRpcProvider | null {
  const remote = remoteChain(genesisHash);
  if (remote === null) {
    return null;
  }
  return onMessage => {
    hooks.onStatus('connecting');
    const connection = remote(onMessage, reason => {
      hooks.onStatus('disconnected');
      hooks.onHalt(new ChainHaltError(reason));
    });
    // The remote provider queues sends until the frame accepts and halts if it refuses,
    // so `connected` may show while the frame is still booting.
    hooks.onStatus('connected');
    return connection;
  };
}
