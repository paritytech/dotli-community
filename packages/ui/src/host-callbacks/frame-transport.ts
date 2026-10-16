// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page runs no light client, so chains go over one remote connection to the protocol frame.

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import type { ChainTransportHooks } from '@dotli/resolver';
import { ChainHaltError, createRemoteChainProvider } from '@dotli/protocol';

/** A halt of the remote connection reaches the pool as `disconnected`, then as a `ChainHaltError`. */
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
    // The remote provider queues sends until the frame accepts and halts if it refuses,
    // so `connected` may show while the frame is still booting.
    hooks.onStatus('connected');
    return connection;
  };
}
