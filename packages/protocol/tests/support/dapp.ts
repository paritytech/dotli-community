// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveSupportedGenesisHashes } from "@dotli/config/network";
import { createRemoteChainProvider } from "@dotli/protocol/client";
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcRequest,
} from "@polkadot-api/json-rpc-provider";

/**
 * Driver representing the sandboxed DApp consumer making chain requests.
 */
export interface DAppDriver {
  /** The low-level JSON-RPC connection instance. */
  readonly connection: JsonRpcConnection;
  /** Send a JSON-RPC request to the chain. */
  send(request: JsonRpcRequest): void;
  /** All JSON-RPC replies received by the dApp so far. */
  replies(): JsonRpcMessage[];
  /** The most recent reply received by the dApp. */
  lastReply(): JsonRpcMessage | undefined;
}

/**
 * Instantiate a test dApp driver connected to the active chain provider.
 */
export function createTestDApp(): DAppDriver {
  const supportedHashes = [...getActiveSupportedGenesisHashes()];
  const genesisHash = supportedHashes[0];
  if (!genesisHash) {
    throw new Error("no active supported genesis hash in test config");
  }
  const provider = createRemoteChainProvider(genesisHash);
  if (!provider) {
    throw new Error("provider refused configured genesis hash");
  }

  const receivedReplies: JsonRpcMessage[] = [];
  const connection = provider((message) => {
    receivedReplies.push(message);
  });

  return {
    connection,
    send(request: JsonRpcRequest): void {
      connection.send(request);
    },
    replies(): JsonRpcMessage[] {
      return [...receivedReplies];
    },
    lastReply(): JsonRpcMessage | undefined {
      return receivedReplies.at(-1);
    },
  };
}
