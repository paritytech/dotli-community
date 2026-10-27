// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';

/** `connectRemote`'s connection, typed as strings to match the postMessage wire. */
export type StringJsonRpcConnection = {
  /** Sends one JSON-RPC message as JSON text. */
  send: (message: string) => void;
  /** Ends the connection. A repeated call does nothing. */
  disconnect: () => void;
};

/** What owns the brokered chain connections of a context. */
export type ChainBrokerManager = {
  /**
   * Opens a session on the chain under `connectionId`, with its messages sent to `onMessage` as JSON text. Returns
   * `null` when this context cannot reach the chain, and throws when `connectionId` already has a session.
   */
  connectRemote(
    genesisHash: string,
    connectionId: string,
    onMessage: (message: string) => void,
  ): StringJsonRpcConnection | null;
  /**
   * A provider whose connections are sessions on the chain, or `null` when this context cannot reach it. `holder`
   * names the lease in debug logs.
   */
  getLocalProvider(genesisHash: string, holder?: string): JsonRpcProvider | null;
  /** Closes every chain and its sessions, without telling them of a halt. */
  disconnectAll(): void;
};

type Params = {
  /** Owns the brokered connections the provider leases. */
  manager: ChainBrokerManager;
  /** The chain to reach. */
  genesisHash: string;
  /** Names the chain in the error thrown when it cannot be reached. */
  label: string;
};

/**
 * A local provider on `genesisHash` leased from `manager`, on the object wire. Throws, naming `label`, when the
 * manager cannot reach the chain.
 */
export function requireBrokerLocalProvider({ manager, genesisHash, label }: Params): JsonRpcProvider {
  const provider = manager.getLocalProvider(genesisHash, 'resolver');
  if (provider === null) {
    throw new Error(`No broker provider available for ${label}`);
  }
  return provider;
}
