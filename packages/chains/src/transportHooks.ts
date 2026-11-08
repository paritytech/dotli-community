// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** `onHalt` means the transport is gone for good. A self-recovering one, such as WebSocket, never halts. */
export type ChainTransportHooks = {
  onStatus: (status: ConnectionStatus) => void;
  onHalt: (error?: unknown) => void;
};

/** A chain's transport, and how many follows one of its connections takes. */
export type ChainTransport = {
  provider: JsonRpcProvider;
  /** The most `chainHead_v1_follow` subscriptions one connection takes. `Infinity` for a transport with no cap. */
  followLimit: number;
};

/** Substrate's RPC server allows 4 follows per connection by default. */
export const RPC_FOLLOW_LIMIT = 4;

/** Smoldot allows 2 follows per JSON-RPC client of a chain, which is one light-client connection. */
export const LIGHT_CLIENT_FOLLOW_LIMIT = 2;

/** Whether a chain is up or on its way up, so it needs no dial of its own. Never throws. */
export function isChainUp(status: ConnectionStatus): boolean {
  switch (status) {
    case 'connecting':
    case 'connected':
      return true;
    case 'disconnected':
      return false;
  }
}
