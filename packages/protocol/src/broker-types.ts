// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcProvider } from "@polkadot-api/json-rpc-provider";

/**
 * String-wire variant of `JsonRpcConnection` exposed by `connectRemote`.
 *
 * The postMessage relay ships `message` as a string, while the upstream
 * `JsonRpcConnection.send` takes `JsonRpcRequest` objects. The local string
 * variant keeps `connectRemote`'s signature matched to the wire.
 */
export interface StringJsonRpcConnection {
  send: (message: string) => void;
  disconnect: () => void;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: JsonRpcId;
  result?: unknown;
  error?: unknown;
}

export interface SubscriptionMessage {
  jsonrpc?: string;
  method?: unknown;
  params?: {
    subscription?: unknown;
    result?: unknown;
  };
}

export interface PendingRequest {
  sessionId: string;
  clientId: JsonRpcId;
  method: string;
}

export interface OwnedToken {
  sessionId: string;
  localToken: string;
  releaseMethod: string;
}

export interface SharedFollow {
  key: string;
  upstreamToken: string | null;
  requestInFlight: boolean;
  localTokens: Set<string>;
  pendingLocals: {
    sessionId: string;
    requestId: JsonRpcId;
    localToken: string;
  }[];
  finalizedBlockHashes: string[];
  finalizedBlockRuntime: unknown;
  bestBlockHash: string | null;
  blocks: Map<string, CachedBlock>;
  /** Block hash -> local follow tokens still holding a pin on it. */
  pins: Map<string, Set<string>>;
}

export interface CachedBlock {
  result: Record<string, unknown>;
  parentBlockHash: string | null;
}

export type WireMode = "string" | "object";

export interface Session {
  id: string;
  onMessage: (message: unknown) => void;
  ownedTokens: Set<string>;
  connected: boolean;
  /** Fixed at session creation, never inferred from message shape later. */
  wireMode: WireMode;
}

/** Internal session handle returned by `ChainBroker.connect()`. */
export interface BrokerConnection {
  send: (message: unknown) => void;
  disconnect: () => void;
}

export interface ChainBrokerManager {
  connectRemote(
    genesisHash: string,
    connectionId: string,
    onMessage: (message: string) => void,
  ): StringJsonRpcConnection | null;
  getLocalProvider(genesisHash: string): JsonRpcProvider | null;
  disconnectAll(): void;
}
