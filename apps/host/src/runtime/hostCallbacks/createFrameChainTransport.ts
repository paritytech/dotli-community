// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host page runs no light client, so chains go over one remote connection to the protocol frame.

import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import type { ChainTransport, ChainTransportHooks } from '@dotli/chains';
import { ChainHaltError } from '@dotli/chains';
import type { RemoteChainProvider } from '@dotli/protocol';

/** Opens remote connections to one chain through the protocol frame, or null for a chain it cannot serve. */
export type RemoteChainFactory = (genesisHash: string) => RemoteChainProvider | null;

type Params = {
  /** Where the remote connections come from. */
  createRemoteChain: RemoteChainFactory;
};

/**
 * The chain's transport through the protocol frame, with no follow limit, or null for a chain the frame cannot serve. A
 * halt of the remote connection reaches the pool as `disconnected`, then as a `ChainHaltError`.
 */
export function createFrameChainTransport(
  genesisHash: string,
  hooks: ChainTransportHooks,
  { createRemoteChain }: Params,
): ChainTransport | null {
  const remote = createRemoteChain(genesisHash);
  if (remote === null) {
    return null;
  }

  return {
    provider(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
      hooks.onStatus('connecting');
      const connection = remote(onMessage, reason => {
        hooks.onStatus('disconnected');
        hooks.onHalt(new ChainHaltError(reason));
      });
      // `connected` shows once the connection is opened, which may be while the frame still boots. A refusal arrives as
      // a halt.
      hooks.onStatus('connected');
      return connection;
    },
    followLimit: Infinity,
  };
}
