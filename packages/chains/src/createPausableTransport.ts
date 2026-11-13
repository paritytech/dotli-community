// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Closes a chain transport's connections on a pause and opens them again on a resume, while the consumers above stay
// connected. What was in flight at the pause is answered or sent again the way a reconnecting proxy does it. What the
// pause ends is answered before `pause` returns, and the rest is sent again on resume.

import { withSubscriptionReplay } from '@novasamatech/host-substrate-chain-connection';
import {
  isResponse,
  type JsonRpcConnection,
  type JsonRpcMessage,
  type JsonRpcProvider,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@polkadot-api/json-rpc-provider';
import { isRecord, runEvery } from '@dotli/shared';
import { createJsonRpcError } from './createJsonRpcError.js';
import {
  CHAIN_HEAD_FOLLOW,
  CHAIN_HEAD_FOLLOW_EVENT,
  CHAIN_HEAD_UNFOLLOW,
  CHAIN_HEAD_UNPIN,
  SUBMIT_AND_WATCH,
  TRANSACTION_BROADCAST,
  TRANSACTION_STOP,
} from './jsonRpcMethods.js';

type Params = {
  /** The transport whose connection a pause closes and a resume opens again. */
  transport: JsonRpcProvider;
};

type PausingConnectionParams = {
  /** The transport each opening of the connection calls. */
  transport: JsonRpcProvider;
  /** The consumer of the connection. */
  onMessage: (message: JsonRpcMessage) => void;
  /** Whether the transport is paused as the connection opens. */
  paused: boolean;
};

type PausingConnection = ReturnType<typeof createPausingConnection>;

/** Where one consumer's connection is in its life. */
type ConnectionState =
  | { kind: 'open'; upstream: JsonRpcConnection }
  | { kind: 'paused'; kept: JsonRpcRequest[]; held: JsonRpcRequest[] }
  | { kind: 'closed' };

type PausedState = Extract<ConnectionState, { kind: 'paused' }>;

/** What a pause does to a request in flight. */
type PauseOutcome = 'done' | 'failed' | 'kept';

/** A request whose id the connection can match to its answer. */
type IdentifiedRequest = JsonRpcRequest & { id: string | number };

/** A transport wrapped so its connection can close and open again while its consumers stay connected. */
export type PausableTransport = ReturnType<typeof createPausableTransport>;

/** Wraps `transport` so a pause closes its connections and a resume opens them again under the same consumers. */
export function createPausableTransport({ transport }: Params) {
  let paused = false;
  const connections = new Set<PausingConnection>();
  // The replay callback is bound to the connection opened last.
  let justOpened: PausingConnection | null = null;

  function connect(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
    const pausing = createPausingConnection({ transport, onMessage, paused });
    connections.add(pausing);
    justOpened = pausing;
    return {
      send: pausing.send,
      disconnect() {
        connections.delete(pausing);
        pausing.disconnect();
      },
    };
  }

  function bindReplay(callback: () => void): () => void {
    const target = justOpened;
    justOpened = null;
    if (target === null) {
      return () => undefined;
    }
    return target.bindReplay(callback);
  }

  const provider = withSubscriptionReplay(connect, bindReplay);

  return {
    /** The provider consumers connect through. Each call opens one connection, at once unless paused. */
    provider,
    /**
     * Closes every open connection's transport connection. A call while paused does nothing. After every connection is
     * closed and every answer delivered, throws what the transport's disconnect or a consumer threw: the one `Error`,
     * or an AggregateError otherwise.
     */
    pause() {
      if (paused) {
        return;
      }
      paused = true;
      runEvery(
        [...connections].map(pausing => pausing.pause),
        'pausable transport: pausing every connection failed',
      );
    },
    /**
     * Opens every connection that is not open and sends what it held. A connection already open is left as it is.
     * After every other connection is open and every delivery made, throws what the transport's reopening, its send or
     * a consumer threw: the one `Error`, or an AggregateError otherwise. A connection whose reopening throws stays
     * closed, keeps what it held, and is opened by the next resume.
     */
    resume() {
      paused = false;
      runEvery(
        [...connections].map(pausing => pausing.resume),
        'pausable transport: resuming every connection failed',
      );
    },
    /** Whether it is paused now. Never throws. */
    isPaused: () => paused,
  };
}

/** One consumer's connection, which outlives the transport connections a pause closes under it. */
function createPausingConnection({ transport, onMessage, paused }: PausingConnectionParams) {
  const initial: PausedState = { kind: 'paused', kept: [], held: [] };
  let state: ConnectionState = initial;
  let replay: (() => void) | null = null;
  // Insertion order is send order, which the resume keeps.
  const inFlight = new Map<string | number, IdentifiedRequest>();
  const follows = new Set<string>();
  // Ids the open transport connection issued.
  const openedIds = new Set<string>();
  // Ids closed transport connections issued that the consumer has not released yet.
  const closedIds = new Set<string>();

  if (!paused) {
    open(initial);
  }

  return {
    send,
    disconnect,
    pause,
    resume,
    /** Runs `callback` after each resume, until the returned unbind. */
    bindReplay(callback: () => void): () => void {
      replay = callback;
      return () => {
        if (replay === callback) {
          replay = null;
        }
      };
    },
  };

  /**
   * Opens a transport connection out of the paused `from`, and returns whether the connection is open on it now. A
   * throw from the transport leaves `from` in place with what it holds.
   */
  function open(from: PausedState): boolean {
    let opened: ConnectionState | null = null;
    const upstream = transport(message => {
      if (state === opened) {
        receive(message);
      }
    });
    // The consumer may leave while the transport connects, which closes this connection before it is ever used.
    if (state !== from) {
      upstream.disconnect();
      return false;
    }
    opened = { kind: 'open', upstream };
    state = opened;
    return true;
  }

  function send(message: JsonRpcRequest): void {
    const released = getReleasedId(message);
    if (released !== null && closedIds.has(released) && !openedIds.has(released)) {
      answerReleaseLocally(message, released);
      return;
    }
    const current = state;
    switch (current.kind) {
      case 'closed':
        return;
      case 'paused':
        current.held.push(message);
        return;
      case 'open':
        if (released !== null && endsReleasedId(message.method)) {
          forget(released);
        }
        if (hasId(message)) {
          inFlight.set(message.id, message);
        }
        current.upstream.send(message);
        return;
    }
  }

  function answerReleaseLocally(message: JsonRpcRequest, released: string): void {
    // An unpin frees blocks of a follow the consumer has yet to release, so the id stays known.
    if (endsReleasedId(message.method)) {
      closedIds.delete(released);
    }
    if (hasId(message)) {
      deliver({ jsonrpc: '2.0', id: message.id, result: null });
    }
  }

  function forget(id: string): void {
    openedIds.delete(id);
    follows.delete(id);
    closedIds.delete(id);
  }

  function receive(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      noteAnswer(message);
    } else {
      const stopped = getStoppedFollow(message);
      if (stopped !== null) {
        follows.delete(stopped);
        openedIds.delete(stopped);
      }
    }
    deliver(message);
  }

  function noteAnswer(message: JsonRpcResponse): void {
    if (message.id === null) {
      return;
    }
    const request = inFlight.get(message.id);
    if (request === undefined) {
      return;
    }
    inFlight.delete(message.id);
    if (!('result' in message) || typeof message.result !== 'string' || !isOpeningMethod(request.method)) {
      return;
    }
    openedIds.add(message.result);
    if (request.method === CHAIN_HEAD_FOLLOW) {
      follows.add(message.result);
    }
  }

  function pause(): void {
    const closing = state;
    if (closing.kind !== 'open') {
      return;
    }
    const stopped = [...follows];
    const requests = [...inFlight.values()];
    for (const id of openedIds) {
      closedIds.add(id);
    }
    openedIds.clear();
    follows.clear();
    inFlight.clear();
    const outcomes = requests.map(request => ({ request, outcome: getPauseOutcome(request.method) }));
    const kept = outcomes.filter(({ outcome }) => outcome === 'kept').map(({ request }) => request);
    state = { kind: 'paused', kept, held: [] };
    // The answers are already taken out of the bookkeeping, so a failing step must not cost a consumer its answer.
    runEvery(
      [
        () => {
          closing.upstream.disconnect();
        },
        ...stopped.map(subscription => () => {
          deliver(createStopEvent(subscription));
        }),
        ...outcomes.map(({ request, outcome }) => () => {
          answerAtPause(request, outcome);
        }),
      ],
      'pausable transport: closing a connection failed',
    );
  }

  function answerAtPause(request: IdentifiedRequest, outcome: PauseOutcome): void {
    switch (outcome) {
      case 'done':
        deliver({ jsonrpc: '2.0', id: request.id, result: null });
        return;
      case 'failed':
        deliver(createJsonRpcError(request.id, 'Internal error'));
        return;
      case 'kept':
        return;
    }
  }

  function resume(): void {
    const from = state;
    if (from.kind !== 'paused') {
      return;
    }
    if (!open(from)) {
      return;
    }
    const pending = [...from.kept, ...from.held];
    runEvery(
      [
        ...pending.map(message => () => {
          send(message);
        }),
        () => {
          replay?.();
        },
      ],
      'pausable transport: resending on a reopened connection failed',
    );
  }

  function disconnect(): void {
    const from = state;
    if (from.kind === 'closed') {
      return;
    }
    state = { kind: 'closed' };
    if (from.kind === 'open') {
      from.upstream.disconnect();
    }
    replay = null;
    inFlight.clear();
    follows.clear();
    openedIds.clear();
    closedIds.clear();
  }

  function deliver(message: JsonRpcMessage): void {
    if (state.kind !== 'closed') {
      onMessage(message);
    }
  }
}

function hasId(message: JsonRpcRequest): message is IdentifiedRequest {
  return typeof message.id === 'string' || typeof message.id === 'number';
}

/** Whether a string answer to `method` is an id a later release names. */
function isOpeningMethod(method: string): boolean {
  if (method === CHAIN_HEAD_FOLLOW || method === TRANSACTION_BROADCAST || method === SUBMIT_AND_WATCH) {
    return true;
  }
  return method.includes('subscribe') && !method.includes('unsubscribe');
}

function isReleaseMethod(method: string): boolean {
  if (method === CHAIN_HEAD_UNFOLLOW || method === CHAIN_HEAD_UNPIN || method === TRANSACTION_STOP) {
    return true;
  }
  return method.includes('unsubscribe') || method.includes('unwatch');
}

/** Whether a release ends the id it names. An unpin names a follow that stays open. */
function endsReleasedId(method: string): boolean {
  return method !== CHAIN_HEAD_UNPIN;
}

/** The id a release names in its first param, or `null` when `message` is no release. */
function getReleasedId(message: JsonRpcRequest): string | null {
  const params: unknown = message.params;
  if (!isReleaseMethod(message.method) || !Array.isArray(params)) {
    return null;
  }
  const first: unknown = params[0];
  return typeof first === 'string' ? first : null;
}

/** The follow a transport `stop` event ends, or `null` for any other message. */
function getStoppedFollow(message: JsonRpcRequest): string | null {
  const params: unknown = message.params;
  if (message.method !== CHAIN_HEAD_FOLLOW_EVENT || !isRecord(params) || !isRecord(params['result'])) {
    return null;
  }
  const subscription = params['subscription'];
  return params['result']['event'] === 'stop' && typeof subscription === 'string' ? subscription : null;
}

function getPauseOutcome(method: string): PauseOutcome {
  if (isReleaseMethod(method)) {
    // Every id in flight at a pause belongs to the closing connection, which a resume never reopens.
    return 'done';
  }
  if (method.startsWith('chainHead_v1_') && method !== CHAIN_HEAD_FOLLOW) {
    return 'failed';
  }
  return 'kept';
}

function createStopEvent(subscription: string): JsonRpcRequest {
  return { jsonrpc: '2.0', method: CHAIN_HEAD_FOLLOW_EVENT, params: { subscription, result: { event: 'stop' } } };
}
