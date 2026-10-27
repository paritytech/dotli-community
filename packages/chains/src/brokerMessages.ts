// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The JSON-RPC messages the broker routes, the state records it keeps per session and follow, and the pure reads and
// builders over them.

import { isRecord } from '@dotli/shared';
import type { FollowSnapshot } from './createFollowSnapshot.js';
import {
  CHAIN_HEAD_FOLLOW,
  CHAIN_HEAD_FOLLOW_EVENT,
  STATEMENT_SUBSCRIBE,
  STATEMENT_UNSUBSCRIBE,
  SUBMIT_AND_WATCH,
  TERMINAL_WATCH_EVENTS,
  TRANSACTION_BROADCAST,
  TRANSACTION_STOP,
  UNWATCH,
  WATCH_EVENT,
} from './jsonRpcMethods.js';
import { readStrings } from './readStrings.js';

export type JsonRpcId = string | number | null;

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
 * owner (a session, a shared follow, a session that left or a release the broker sent itself), so an answer is never
 * routed by guessing what its id holds.
 */
export type RequestOwner =
  /**
   * A session's own request, answered under the session's id for it. A release it sends as the last owner carries
   * `upstreamToken`, since the node may still send events it queued for that subscription.
   */
  | { kind: 'session'; sessionId: string; clientId: JsonRpcId; method: string; upstreamToken?: string | undefined }
  /** The upstream follow a shared follow waits on, answered to every session waiting on it. */
  | { kind: 'follow'; follow: SharedFollow }
  /**
   * A request whose session left before the answer. A subscription the answer opens is released at once. A release
   * keeps its `upstreamToken` for the events the node may still send for it.
   */
  | { kind: 'orphan'; method: string; upstreamToken?: string | undefined }
  /**
   * A release the broker sent itself for `upstreamToken`. Nobody waits on its answer, and until it comes the node may
   * still send events it queued for that subscription.
   */
  | { kind: 'release'; method: string; upstreamToken: string };

export type OwnedToken = {
  sessionId: string;
  localToken: string;
  upstreamToken: string;
  releaseMethod: string;
};

export type SharedFollow = {
  key: string;
  upstreamToken: string | null;
  localTokens: Set<string>;
  pendingLocals: {
    sessionId: string;
    requestId: JsonRpcId;
    localToken: string;
  }[];
  /** What the follow told its sessions so far, and who still pins each of its blocks. */
  snapshot: FollowSnapshot;
};

export type WireMode = 'string' | 'object';

export type Session = {
  id: string;
  /** Hears each message for the session, encoded for its wire mode. */
  onMessage: (message: unknown) => void;
  ownedTokens: Set<string>;
  connected: boolean;
  wireMode: WireMode;
  /** Told once when the chain's transport halts for good. */
  onHalt: ((error?: unknown) => void) | null;
};

/** A local token a session holds, for adding it to the session's set or dropping it. */
export type SessionTokenParams = {
  /** The session that holds the token. A session that has gone is left alone. */
  sessionId: string;
  /** The local token, as the session sees it. */
  token: string;
};

/** A release the broker sends itself, for something no session holds anymore. */
export type SendReleaseParams = {
  /** The release method, such as an unfollow, an unpin or a stop. */
  method: string;
  /** The upstream subscription it releases. */
  upstreamToken: string;
  /** What the request carries after the token. */
  params?: unknown[];
};

export type BrokerConnection = {
  /** Routes one message from the session, as a JSON string or an object. Dropped once the session is gone. */
  send: (message: unknown) => void;
  /** Ends the session and releases what it holds. A repeated call does nothing. */
  disconnect: () => void;
};

export const TOKEN_METHODS = new Map<string, string>([
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

/** `chainHead_v1_unpin` takes its hash arg as a string or an array. */
export function normalizeUnpinHashes(param: unknown): string[] {
  return typeof param === 'string' ? [param] : readStrings(param);
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

export function getOwnerMethod(owner: RequestOwner): string {
  switch (owner.kind) {
    case 'follow':
      return CHAIN_HEAD_FOLLOW;
    case 'session':
    case 'orphan':
    case 'release':
      return owner.method;
  }
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
