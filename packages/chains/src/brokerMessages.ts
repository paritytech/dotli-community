// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The JSON-RPC messages the broker routes, the state records it keeps per session and subscription, and the pure reads
// and builders over them.

import { isRecord } from '@dotli/shared';
import {
  CHAIN_HEAD_FOLLOW,
  CHAIN_HEAD_FOLLOW_EVENT,
  CHAIN_HEAD_UNFOLLOW,
  STATEMENT_SUBSCRIBE,
  STATEMENT_UNSUBSCRIBE,
  SUBMIT_AND_WATCH,
  TERMINAL_WATCH_EVENTS,
  TRANSACTION_BROADCAST,
  TRANSACTION_STOP,
  UNWATCH,
  WATCH_EVENT,
} from './jsonRpcMethods.js';

type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc?: string;
  id?: JsonRpcId;
  result?: unknown;
  error?: unknown;
};

export type SubscriptionMessage = {
  jsonrpc?: string;
  method?: unknown;
  params?: {
    subscription?: unknown;
    result?: unknown;
  };
};

/**
 * Who the answer to an upstream request goes to. Each request the broker sends upstream with an id has exactly one
 * owner (a session, a session that left or a release the broker sent itself), so an answer is never routed by guessing
 * what its id holds.
 */
export type RequestOwner =
  /**
   * A session's own request, answered to the session under its own id. A session that leaves hands it to an orphan
   * owner. A release it sends as the last owner carries `upstreamToken`, since the node may still send events it queued
   * for that subscription.
   */
  | { kind: 'session'; session: Session; clientId: JsonRpcId; method: string; upstreamToken?: string | undefined }
  /**
   * A request whose session left before the answer, or a follow a session sent without an id. A subscription the
   * answer opens is released at once. A release keeps its `upstreamToken` for
   * the events the node may still send for it.
   */
  | { kind: 'orphan'; method: string; upstreamToken?: string | undefined }
  /**
   * A release the broker sent itself for `upstreamToken`. Nobody waits on its answer, and until it comes the node may
   * still send events it queued for that subscription.
   */
  | { kind: 'release'; method: string; upstreamToken: string };

export type OwnedToken = {
  session: Session;
  localToken: string;
  upstreamToken: string;
  releaseMethod: string;
};

export type WireMode = 'string' | 'object';

export type Session = {
  id: string;
  /** Hears each message for the session, encoded for its wire mode. */
  onMessage: (message: unknown) => void;
  wireMode: WireMode;
  /** Told once when the chain's transport halts for good. */
  onHalt: ((error?: unknown) => void) | null;
};

export type BrokerConnection = {
  /** Routes one message from the session, as a JSON string or an object. Dropped once the session is gone. */
  send: (message: unknown) => void;
  /** Ends the session and releases what it holds. A repeated call does nothing. */
  disconnect: () => void;
};

export const TOKEN_METHODS = new Map<string, string>([
  [CHAIN_HEAD_FOLLOW, CHAIN_HEAD_UNFOLLOW],
  [TRANSACTION_BROADCAST, TRANSACTION_STOP],
  [SUBMIT_AND_WATCH, UNWATCH],
  [STATEMENT_SUBSCRIBE, STATEMENT_UNSUBSCRIBE],
]);
export const RELEASE_METHODS = new Set<string>(TOKEN_METHODS.values());

// Fixed per session, never sniffed from message shape, so one malformed payload cannot flip the
// encoding of every later message. "string" because first-party consumers send JSON strings.
export const DEFAULT_WIRE_MODE: WireMode = 'string';

export function isRequestMessage(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && typeof value['method'] === 'string';
}

export function isResponseMessage(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && 'id' in value && !('method' in value);
}

export function isSubscriptionMessage(value: unknown): value is SubscriptionMessage {
  return isRecord(value) && 'method' in value && isRecord(value['params']) && 'subscription' in value['params'];
}

/** Parses strings on the object wire too, since some substrate clients serialize inconsistently. */
export function parseInboundMessage(message: unknown): unknown {
  if (typeof message === 'string') {
    return JSON.parse(message);
  }
  return message;
}

export function encodeForWire(value: unknown, mode: WireMode): unknown {
  switch (mode) {
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return value;
  }
}

export function buildJsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function cloneWithRewrittenFirstParam(request: JsonRpcRequest, rewrittenToken: string): JsonRpcRequest {
  const params: unknown[] = Array.isArray(request.params) ? request.params.slice() : [];
  params[0] = rewrittenToken;
  return { ...request, params };
}

/** The upstream subscription message `message` under the local token a session holds for it. */
export function readdressSubscription(message: SubscriptionMessage, localToken: string): SubscriptionMessage {
  return { ...message, params: { ...message.params, subscription: localToken } };
}

/** A chainHead follow event that tells the session holding `localToken` the follow's `result`. */
export function buildFollowEvent(localToken: string, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', method: CHAIN_HEAD_FOLLOW_EVENT, params: { subscription: localToken, result } };
}

export function getReleaseResult(method: string): unknown {
  return method === STATEMENT_UNSUBSCRIBE ? true : null;
}

/** Whether `event` ends its subscription on the node's side, so nothing is sent upstream to end it again. */
export function isSubscriptionEnd(method: unknown, event: unknown): boolean {
  if (event === 'stop') {
    return true;
  }
  return method === WATCH_EVENT && typeof event === 'string' && TERMINAL_WATCH_EVENTS.has(event);
}

/** The event a subscription message carries, for the debug log. */
export function getEventType(result: unknown): string {
  if (!isRecord(result)) {
    return '?';
  }
  return typeof result['event'] === 'string' ? result['event'] : 'unknown';
}

export function describeResponse(response: JsonRpcResponse): string {
  if ('error' in response) {
    return `error=${JSON.stringify(response.error)}`;
  }
  if (typeof response.result === 'string' && response.result.length > 200) {
    return `result=${response.result.slice(0, 200)}... (${String(response.result.length)} chars)`;
  }
  return `result=${JSON.stringify(response.result)}`;
}
