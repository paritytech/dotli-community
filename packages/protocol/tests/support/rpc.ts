// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcRequest,
  JsonRpcResponse,
} from "@polkadot-api/json-rpc-provider";

/**
 * Factory for JSON-RPC messages used in protocol provider tests.
 */
export const Rpc = {
  request: (
    id: number,
    method = "chain_getBlock",
    params: unknown[] = [],
  ): JsonRpcRequest => ({
    jsonrpc: "2.0",
    id,
    method,
    params,
  }),
  response: <T>(id: number, result: T): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    result,
  }),
  error: (
    id: number,
    code = -32603,
    message?: string | RegExp,
  ): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id,
    error: message !== undefined ? { code, message } : { code },
  }),
};
