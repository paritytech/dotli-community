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
import { runEvery } from '@dotli/shared';
import { createJsonRpcError } from './createJsonRpcError.js';
import {
  CHAIN_HEAD_FOLLOW,
  CHAIN_HEAD_FOLLOW_EVENT,
  CHAIN_HEAD_UNFOLLOW,
  CHAIN_HEAD_UNPIN,
  STATEMENT_UNSUBSCRIBE,
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

/** What a pause does to a request in flight. */
type PauseOutcome = 'done' | 'failed' | 'kept';

/** A request whose id the connection can match to its answer. */
type IdentifiedRequest = JsonRpcRequest & { id: string | number };

const CHAIN_HEAD_PREFIX = 'chainHead_v1_';

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
     * Opens them again and sends what was held. A call while not paused does nothing. After every other connection is
     * open and every delivery made, throws what the transport's reopening, its send or a consumer threw: the one
     * `Error`, or an AggregateError otherwise. A connection whose reopening throws stays closed and keeps what it held.
     */
    resume() {
      if (!paused) {
        return;
      }
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
  // `null` while paused and once the consumer has left.
  let upstream: JsonRpcConnection | null = null;
  // Bumped on each close, so a transport connection already closed cannot deliver.
  let generation = 0;
  let closed = false;
  let replay: (() => void) | null = null;
  // Insertion order is send order, which the resume keeps.
  const inFlight = new Map<string | number, IdentifiedRequest>();
  const follows = new Set<string>();
  // Ids the open transport connection issued.
  const openedIds = new Set<string>();
  // Ids closed transport connections issued that the consumer has not released yet.
  const closedIds = new Set<string>();
  let kept: JsonRpcRequest[] = [];
  let held: JsonRpcRequest[] = [];

  if (!paused) {
    open();
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

  function open(): void {
    generation += 1;
    const own = generation;
    upstream = transport(message => {
      if (generation === own) {
        receive(message);
      }
    });
  }

  function send(message: JsonRpcRequest): void {
    if (closed) {
      return;
    }
    const released = getReleasedId(message);
    if (released !== null && closedIds.has(released) && !openedIds.has(released)) {
      answerReleaseLocally(message, released);
      return;
    }
    if (upstream === null) {
      held.push(message);
      return;
    }
    if (released !== null && endsReleasedId(message.method)) {
      forget(released);
    }
    if (hasId(message)) {
      inFlight.set(message.id, message);
    }
    upstream.send(message);
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
    if (upstream === null) {
      return;
    }
    const closing = upstream;
    upstream = null;
    generation += 1;
    const stopped = [...follows];
    const requests = [...inFlight.values()];
    for (const id of openedIds) {
      closedIds.add(id);
    }
    openedIds.clear();
    follows.clear();
    inFlight.clear();
    const outcomes = requests.map(request => ({ request, outcome: getPauseOutcome(request.method) }));
    kept = outcomes.filter(({ outcome }) => outcome === 'kept').map(({ request }) => request);
    // The answers are already taken out of the bookkeeping, so a failing step must not cost a consumer its answer.
    runEvery(
      [
        () => {
          closing.disconnect();
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
    if (closed || upstream !== null) {
      return;
    }
    open();
    const pending = [...kept, ...held];
    kept = [];
    held = [];
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
    if (closed) {
      return;
    }
    closed = true;
    generation += 1;
    upstream?.disconnect();
    upstream = null;
    replay = null;
    inFlight.clear();
    follows.clear();
    openedIds.clear();
    closedIds.clear();
    kept = [];
    held = [];
  }

  function deliver(message: JsonRpcMessage): void {
    if (!closed) {
      onMessage(message);
    }
  }
}

function hasId(message: JsonRpcRequest): message is IdentifiedRequest {
  return typeof message.id === 'string' || typeof message.id === 'number';
}

function isChainHeadMethod(method: string): boolean {
  return method.startsWith(CHAIN_HEAD_PREFIX);
}

/** Whether a string answer to `method` is an id a later release names. */
function isOpeningMethod(method: string): boolean {
  if (method === CHAIN_HEAD_FOLLOW || method === TRANSACTION_BROADCAST || method === SUBMIT_AND_WATCH) {
    return true;
  }
  return method.includes('subscribe') && !method.includes('unsubscribe');
}

function isReleaseMethod(method: string): boolean {
  if (
    method === CHAIN_HEAD_UNFOLLOW ||
    method === CHAIN_HEAD_UNPIN ||
    method === TRANSACTION_STOP ||
    method === STATEMENT_UNSUBSCRIBE
  ) {
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
  if (message.method !== CHAIN_HEAD_FOLLOW_EVENT) {
    return null;
  }
  const params: unknown = message.params;
  if (typeof params !== 'object' || params === null || !('subscription' in params) || !('result' in params)) {
    return null;
  }
  const { subscription, result } = params;
  if (typeof subscription !== 'string' || typeof result !== 'object' || result === null || !('event' in result)) {
    return null;
  }
  return result.event === 'stop' ? subscription : null;
}

function getPauseOutcome(method: string): PauseOutcome {
  if (isReleaseMethod(method)) {
    // Every id in flight at a pause belongs to the closing connection, which a resume never reopens.
    return 'done';
  }
  if (isChainHeadMethod(method) && method !== CHAIN_HEAD_FOLLOW) {
    return 'failed';
  }
  return 'kept';
}

function createStopEvent(subscription: string): JsonRpcRequest {
  return { jsonrpc: '2.0', method: CHAIN_HEAD_FOLLOW_EVENT, params: { subscription, result: { event: 'stop' } } };
}
