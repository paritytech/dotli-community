// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host pool's transport on the light client backends: one remote
// connection to the protocol frame, whose light client serves the chain. The
// host page runs no light client of its own.

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainTransportHooks } from '@dotli/resolver';
import { ChainHaltError, createRemoteChainProvider } from '@dotli/protocol';

/**
 * A chain transport over the protocol frame, or `null` when the frame cannot
 * serve this chain. A halt of the remote connection reaches the pool as
 * `disconnected`, then as a `ChainHaltError` that carries its reason.
 */
export function createFrameChainTransport(genesisHash: string, hooks: ChainTransportHooks): JsonRpcProvider | null {
  const remote = createRemoteChainProvider(genesisHash);
  if (remote === null) {
    return null;
  }
  return onMessage => {
    hooks.onStatus('connecting');
    const connection = remote(onMessage, reason => {
      hooks.onStatus('disconnected');
      hooks.onHalt(new ChainHaltError(reason));
    });
    // The remote provider says nothing finer: it queues sends until the frame
    // accepts the connection, and halts if the frame refuses it.
    hooks.onStatus('connected');
    return connection;
  };
}
