// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  SubscriptionMessage,
  WireMode,
} from "./broker-types.ts";

export function isJsonRpcObject(
  value: unknown,
): value is Record<string, unknown> & { jsonrpc?: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildJsonRpcError(
  id: JsonRpcId,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code: -32603, message } };
}

export function buildJsonRpcResult(
  id: JsonRpcId,
  result: unknown,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function isRequestMessage(value: unknown): value is JsonRpcRequest {
  return isJsonRpcObject(value) && typeof value.method === "string";
}

export function isResponseMessage(value: unknown): value is JsonRpcResponse {
  return isJsonRpcObject(value) && "id" in value && !("method" in value);
}

export function isSubscriptionMessage(
  value: unknown,
): value is SubscriptionMessage {
  return (
    isJsonRpcObject(value) &&
    "method" in value &&
    isJsonRpcObject(value.params) &&
    "subscription" in value.params
  );
}

/**
 * Parse an inbound message into a JS object without guessing wire mode.
 * The sender must match the broker's configured wire mode. Message shape
 * never flips the whole broker's encoding. Strings are parsed for the
 * object wire too, since some substrate clients serialize payloads
 * inconsistently, but the result is always returned as an object.
 */
export function parseInbound(message: unknown): unknown {
  if (typeof message === "string") {
    return JSON.parse(message);
  }
  return message;
}

/** Encode a JS object into the given wire format. */
export function encode(value: unknown, mode: WireMode): unknown {
  return mode === "string" ? JSON.stringify(value) : value;
}

/** `chainHead_v1_unpin` takes its hash arg as a string or an array; normalize to an array. */
export function normalizeUnpinHashes(param: unknown): string[] {
  if (typeof param === "string") {
    return [param];
  }
  if (Array.isArray(param)) {
    return param.filter((hash): hash is string => typeof hash === "string");
  }
  return [];
}

export function cloneWithRewrittenFirstParam(
  request: JsonRpcRequest,
  rewrittenToken: string,
): JsonRpcRequest {
  const params: unknown[] = Array.isArray(request.params)
    ? [...(request.params as unknown[])]
    : [];
  params[0] = rewrittenToken;
  return { ...request, params };
}
