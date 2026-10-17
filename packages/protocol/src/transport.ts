// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One transport per provider, for the provider's whole life. The consumer end handshakes, holds calls until the
// handshake is answered, and matches answers and legs to its calls by id. The serving end answers the handshake itself
// and runs the handler registered for each method. Every post encodes a fresh buffer, since a transferred one is
// detached.

import { m, reportListener, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import { ProtocolHandshakeTimeoutError, ProtocolRequestError, ProtocolVersionMismatchError } from './errors.js';
import {
  WIRE_VERSION,
  type Answer,
  type ProtocolMethod,
  type RequestMethod,
  type RequestPayload,
  type SubscribePayload,
  type SubscriptionEvent,
  type SubscriptionMethod,
} from './methods.js';
import type { Provider } from './provider.js';
import { decodeWireMessage, encodeWireMessage, toWireError, type WireError, type WireMessage } from './wire-message.js';

const DEFAULT_RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
// The largest id the wire's u32 carries. Ids wrap long after any call with an old one has settled.
const MAX_ID = 0xffff_ffff;

type Count = typeof m.count;

export interface CallOptions {
  /** When the caller stops waiting, in ms since the epoch. The serving handler reads it to size its own budget. */
  deadlineMs?: number;
}

export interface Subscription {
  /** Ends the subscription without calling its end listeners. */
  unsubscribe(): void;
  /** Hears the one end: null when the serving side ended cleanly, else why it ended. Called at once if it has. */
  onEnd(listener: (error: Error | null) => void): void;
}

export interface ConsumerTransport {
  /** Starts the handshake. Calls made before it, or while it runs, wait and go out in call order once it succeeds. */
  connect(): void;
  whenConnected(): Promise<void>;
  request<M extends RequestMethod>(method: M, payload: RequestPayload<M>, options?: CallOptions): Promise<Answer<M>>;
  subscribe<M extends SubscriptionMethod>(
    method: M,
    payload: SubscribePayload<M>,
    onEvent: (event: SubscriptionEvent<M>) => void,
    options?: CallOptions,
  ): Subscription;
  /** Rejects every call and ends every subscription with `reason`, and so does every later call. */
  dispose(reason: Error): void;
}

export interface ConsumerTransportOptions {
  /** The page's resolution id, which the serving side reads from each call's context. */
  resolutionId?: string;
  retryMs?: number;
  timeoutMs?: number;
  timers?: Timers;
  count?: Count;
  side: 'host' | 'frame';
}

export interface CallContext {
  /** The peer's origin when the call arrived, or null when it has none. */
  origin: string | null;
  deadlineMs: number | null;
  resolutionId: string | null;
}

export interface SubscriptionSink<M extends SubscriptionMethod> {
  /** Does nothing once the subscription has stopped. */
  send(event: SubscriptionEvent<M>): void;
  /** Ends the subscription once. Later calls do nothing. */
  end(error?: Error): void;
}

export type RequestHandler<M extends RequestMethod> = (
  payload: RequestPayload<M>,
  context: CallContext,
) => Answer<M> | Promise<Answer<M>>;

/** Starts a subscription and returns what stops it, which runs once on an unsubscribe, an end or a dispose. */
export type SubscriptionHandler<M extends SubscriptionMethod> = (
  payload: SubscribePayload<M>,
  context: CallContext,
  sink: SubscriptionSink<M>,
) => () => void;

export interface ServingTransport {
  /** One handler per method. Returns what unregisters it. */
  handleRequest<M extends RequestMethod>(method: M, handler: RequestHandler<M>): () => void;
  handleSubscription<M extends SubscriptionMethod>(method: M, handler: SubscriptionHandler<M>): () => void;
  /** Stops every running subscription and tells the peer each ended with `reason`. */
  dispose(reason: Error): void;
}

const report = reportListener('protocol', 'protocol.transport');

/** Runs a callback the transport does not own, so one that throws is reported and the transport carries on. */
function guarded<A extends unknown[]>(callback: (...args: A) => void, ...args: A): void {
  try {
    callback(...args);
  } catch (error) {
    report(error);
  }
}

/** Posts on the way out of a subscription or a transport. The peer may be gone already, and nothing waits on it. */
function postLeaving(provider: Provider, message: WireMessage): void {
  try {
    provider.post(encodeWireMessage(message));
    // eslint-disable-next-line no-restricted-syntax -- the subscription or transport is over on this side whatever the peer hears.
  } catch {
    /* a peer that is gone needs no goodbye */
  }
}

function receive(data: ArrayBuffer, count: Count, side: 'host' | 'frame' | 'worker'): WireMessage | null {
  const decoded = decodeWireMessage(data);
  if (!decoded.ok) {
    count(S.PROTOCOL_WIRE_REFUSED, { outcome: 'refused', reason: decoded.reason, side });
    return null;
  }
  return decoded.message;
}

/** A remote failure as a local error. The remote class name and stack travel as fields of it. */
function fromWire(error: WireError, method: ProtocolMethod): Error {
  if (method === 'handshake' && error.name === 'ProtocolVersionMismatchError') {
    return new ProtocolVersionMismatchError(error.message);
  }
  return new ProtocolRequestError(error.message, error.name ?? 'Error', method, error.stack ?? undefined);
}

function unhandled(method: ProtocolMethod): Error {
  return new Error(`This end does not handle ${method}`);
}

interface RequestCall {
  kind: 'request';
  id: number;
  method: RequestMethod;
  payload: unknown;
  deadlineMs: number | null;
  resolve: (answer: unknown) => void;
  reject: (error: unknown) => void;
}

interface SubscriptionCall {
  kind: 'subscription';
  id: number;
  method: SubscriptionMethod;
  payload: unknown;
  deadlineMs: number | null;
  onEvent: (event: unknown) => void;
  endListeners: ((error: Error | null) => void)[];
  state: { name: 'queued' | 'open' | 'unsubscribed' } | { name: 'ended'; error: Error | null };
}

type Call = RequestCall | SubscriptionCall;

type Phase = { name: 'idle' | 'connecting' | 'connected' } | { name: 'failed' | 'disposed'; error: Error };

export function createConsumerTransport(provider: Provider, options: ConsumerTransportOptions): ConsumerTransport {
  const { side } = options;
  const timers = options.timers ?? realTimers;
  const count = options.count ?? m.count;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolutionId = options.resolutionId ?? null;

  let phase: Phase = { name: 'idle' };
  let lastId = 0;
  const queue: Call[] = [];
  const waiting = new Map<number, RequestCall>();
  const open = new Map<number, SubscriptionCall>();
  const connectWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const handshakePool = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: retryMs,
    timers,
  });
  const stopHandshake = new AbortController();
  let answerHandshake: ((error: Error | null) => void) | undefined;

  const nextId = (): number => {
    lastId = lastId >= MAX_ID ? 1 : lastId + 1;
    return lastId;
  };

  const closedBy = (): Error | null => (phase.name === 'failed' || phase.name === 'disposed' ? phase.error : null);

  /** Takes a subscription out of the queue and the open map, wherever it still is. */
  const forget = (call: SubscriptionCall): void => {
    const index = queue.indexOf(call);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    if (open.get(call.id) === call) {
      open.delete(call.id);
    }
  };

  /** Ends a subscription once. It leaves the maps before any listener runs, so a listener may call anything. */
  const end = (call: SubscriptionCall, error: Error | null): void => {
    if (call.state.name === 'ended' || call.state.name === 'unsubscribed') {
      return;
    }
    forget(call);
    call.state = { name: 'ended', error };
    for (const listener of call.endListeners.splice(0)) {
      guarded(listener, error);
    }
  };

  const send = (call: Call): void => {
    const { id, method, payload, deadlineMs } = call;
    let data: ArrayBuffer;
    try {
      data = encodeWireMessage({
        leg: call.kind === 'request' ? 'request' : 'subscribe',
        id,
        method,
        deadlineMs,
        payload,
      } as WireMessage);
    } catch (error) {
      if (call.kind === 'request') {
        call.reject(error);
      } else {
        end(call, toError(error));
      }
      return;
    }
    if (call.kind === 'request') {
      waiting.set(id, call);
    } else {
      call.state = { name: 'open' };
      open.set(id, call);
    }
    try {
      provider.post(data);
    } catch (error) {
      if (call.kind === 'request') {
        waiting.delete(id);
        call.reject(error);
      } else {
        end(call, toError(error));
      }
    }
  };

  /** Sends now when connected, else waits in the queue. */
  const place = (call: Call): void => {
    if (phase.name === 'connected') {
      send(call);
    } else {
      queue.push(call);
    }
  };

  const onConnected = (): void => {
    stopHandshake.abort();
    if (phase.name !== 'connecting') {
      return;
    }
    // The phase stays `connecting` until the queue is empty, so a call made from a listener meanwhile queues behind.
    for (let call = queue.shift(); call !== undefined; call = queue.shift()) {
      send(call);
    }
    if (closedBy() !== null) {
      return;
    }
    phase = { name: 'connected' };
    for (const waiter of connectWaiters.splice(0)) {
      waiter.resolve();
    }
  };

  /** Settles calls that have already left the queue and the maps, once the phase says why they end. */
  const settle = (calls: Call[], error: Error): void => {
    for (const waiter of connectWaiters.splice(0)) {
      waiter.reject(error);
    }
    for (const call of calls) {
      if (call.kind === 'request') {
        call.reject(error);
      } else {
        end(call, error);
      }
    }
  };

  const onHandshakeFailed = (error: unknown): void => {
    stopHandshake.abort(error);
    if (phase.name !== 'connecting') {
      return;
    }
    const reason = toError(error);
    phase = { name: 'failed', error: reason };
    settle(queue.splice(0), reason);
  };

  const postHandshake = (): void => {
    provider.post(
      encodeWireMessage({
        leg: 'request',
        id: nextId(),
        method: 'handshake',
        deadlineMs: null,
        payload: { version: WIRE_VERSION, resolutionId },
      }),
    );
  };

  const onMessage = (data: ArrayBuffer): void => {
    const message = receive(data, count, side);
    if (message === null) {
      return;
    }
    switch (message.leg) {
      case 'response': {
        const outcome = message.outcome;
        if (message.method === 'handshake') {
          // Only the first answer counts, and a settled answer ignores the repeats.
          answerHandshake?.(outcome.ok ? null : fromWire(outcome.error, 'handshake'));
          return;
        }
        const call = waiting.get(message.id);
        if (call?.method !== message.method) {
          return;
        }
        waiting.delete(message.id);
        if (outcome.ok) {
          call.resolve(outcome.answer);
        } else {
          call.reject(fromWire(outcome.error, message.method));
        }
        return;
      }
      case 'event': {
        const call = open.get(message.id);
        if (call?.method === message.method) {
          guarded(call.onEvent, message.event);
        }
        return;
      }
      case 'end': {
        const call = open.get(message.id);
        if (call?.method === message.method) {
          end(call, message.error === null ? null : fromWire(message.error, message.method));
        }
        return;
      }
      case 'request':
      case 'subscribe':
      case 'unsubscribe':
        // A consumer serves nothing, so a call leg from the peer has no one to answer it.
        return;
    }
  };
  // Providers do not buffer, so the listener is bound before anything can arrive.
  const unsubscribeProvider = provider.subscribe(onMessage);

  return {
    connect() {
      if (phase.name !== 'idle') {
        return;
      }
      phase = { name: 'connecting' };
      const answered = new Promise<void>((resolve, reject) => {
        answerHandshake = error => {
          if (error === null) {
            resolve();
          } else {
            reject(error);
          }
        };
      });
      // An attempt fails until an answer comes, so the pool posts a fresh handshake every `retryMs` until it is
      // stopped. It settles only when stopped, which the race below has outlived or reports.
      const retrying = handshakePool.call<never>(
        () => {
          postHandshake();
          throw new Error('The handshake is not answered yet');
        },
        { signal: stopHandshake.signal },
      );
      void withTimeout(
        Promise.race([answered, retrying]),
        timeoutMs,
        () => new ProtocolHandshakeTimeoutError(`No handshake answer within ${String(timeoutMs)} ms`),
        timers,
      ).then(onConnected, onHandshakeFailed);
    },

    whenConnected() {
      const closed = closedBy();
      if (closed !== null) {
        return Promise.reject(closed);
      }
      if (phase.name === 'connected') {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        connectWaiters.push({ resolve, reject });
      });
    },

    request(method, payload, callOptions = {}) {
      return new Promise((resolve, reject) => {
        const closed = closedBy();
        if (closed !== null) {
          reject(closed);
          return;
        }
        place({
          kind: 'request',
          id: nextId(),
          method,
          payload,
          deadlineMs: callOptions.deadlineMs ?? null,
          resolve: resolve as (answer: unknown) => void,
          reject,
        });
      });
    },

    subscribe(method, payload, onEvent, callOptions = {}) {
      const call: SubscriptionCall = {
        kind: 'subscription',
        id: nextId(),
        method,
        payload,
        deadlineMs: callOptions.deadlineMs ?? null,
        onEvent: onEvent as (event: unknown) => void,
        endListeners: [],
        state: { name: 'queued' },
      };
      const closed = closedBy();
      if (closed === null) {
        place(call);
      } else {
        call.state = { name: 'ended', error: closed };
      }
      return {
        unsubscribe() {
          const was = call.state.name;
          if (was === 'ended' || was === 'unsubscribed') {
            return;
          }
          forget(call);
          call.state = { name: 'unsubscribed' };
          call.endListeners.length = 0;
          if (was === 'open') {
            postLeaving(provider, { leg: 'unsubscribe', id: call.id, method: call.method });
          }
        },
        onEnd(listener) {
          if (call.state.name === 'ended') {
            guarded(listener, call.state.error);
          } else if (call.state.name !== 'unsubscribed') {
            call.endListeners.push(listener);
          }
        },
      };
    },

    dispose(reason) {
      if (phase.name === 'disposed') {
        return;
      }
      phase = { name: 'disposed', error: reason };
      stopHandshake.abort(reason);
      const subscriptions = [...open.values()];
      const calls = [...queue.splice(0), ...waiting.values(), ...subscriptions];
      waiting.clear();
      open.clear();
      for (const call of subscriptions) {
        postLeaving(provider, { leg: 'unsubscribe', id: call.id, method: call.method });
      }
      unsubscribeProvider();
      provider.dispose();
      settle(calls, reason);
    },
  };
}

type LooseRequestHandler = (payload: unknown, context: CallContext) => unknown;
type LooseSubscriptionHandler = (
  payload: unknown,
  context: CallContext,
  sink: { send(event: unknown): void; end(error?: Error): void },
) => () => void;

interface Running {
  method: SubscriptionMethod;
  /** Null until the handler returns it. */
  stop: (() => void) | null;
}

export function createServingTransport(
  provider: Provider,
  options: { count?: Count; side: 'frame' | 'worker' },
): ServingTransport {
  const { side } = options;
  const count = options.count ?? m.count;
  const requestHandlers = new Map<RequestMethod, LooseRequestHandler>();
  const subscriptionHandlers = new Map<SubscriptionMethod, LooseSubscriptionHandler>();
  const running = new Map<number, Running>();
  let resolutionId: string | null = null;
  let disposed = false;

  const contextOf = (deadlineMs: number | null): CallContext => ({
    origin: provider.peerOrigin(),
    deadlineMs,
    resolutionId,
  });

  const respond = (
    id: number,
    method: RequestMethod | 'handshake',
    outcome: { ok: true; answer: unknown } | { ok: false; error: unknown },
  ): void => {
    if (disposed) {
      return;
    }
    const answer = (wireOutcome: unknown): ArrayBuffer =>
      encodeWireMessage({ leg: 'response', id, method, outcome: wireOutcome } as WireMessage);
    let data: ArrayBuffer;
    try {
      data = answer(outcome.ok ? outcome : { ok: false, error: toWireError(outcome.error) });
    } catch (error) {
      data = answer({ ok: false, error: toWireError(error) });
    }
    provider.post(data);
  };

  const postEnd = (id: number, method: SubscriptionMethod, error: Error | null): void => {
    provider.post(encodeWireMessage({ leg: 'end', id, method, error: error === null ? null : toWireError(error) }));
  };

  const onHandshake = (id: number, payload: RequestPayload<'handshake'>): void => {
    if (payload.version !== WIRE_VERSION) {
      const mismatch = new ProtocolVersionMismatchError(
        `The peer speaks wire version ${String(payload.version)} and this end ${String(WIRE_VERSION)}`,
      );
      respond(id, 'handshake', { ok: false, error: mismatch });
      return;
    }
    resolutionId = payload.resolutionId;
    respond(id, 'handshake', { ok: true, answer: undefined });
  };

  const onRequest = (id: number, method: RequestMethod, deadlineMs: number | null, payload: unknown): void => {
    const handler = requestHandlers.get(method);
    if (handler === undefined) {
      respond(id, method, { ok: false, error: unhandled(method) });
      return;
    }
    // A handler that throws at once answers like one that rejects.
    void new Promise<unknown>(resolve => {
      resolve(handler(payload, contextOf(deadlineMs)));
    }).then(
      answer => {
        respond(id, method, { ok: true, answer });
      },
      (error: unknown) => {
        respond(id, method, { ok: false, error });
      },
    );
  };

  const onSubscribe = (id: number, method: SubscriptionMethod, deadlineMs: number | null, payload: unknown): void => {
    if (running.has(id)) {
      return;
    }
    const handler = subscriptionHandlers.get(method);
    if (handler === undefined) {
      postEnd(id, method, unhandled(method));
      return;
    }
    const entry: Running = { method, stop: null };
    running.set(id, entry);
    const isCurrent = (): boolean => running.get(id) === entry;
    const finish = (error: Error | null): void => {
      if (!isCurrent()) {
        return;
      }
      running.delete(id);
      if (entry.stop !== null) {
        guarded(entry.stop);
      }
      postEnd(id, method, error);
    };
    const sink = {
      send(event: unknown) {
        if (!isCurrent()) {
          return;
        }
        let data: ArrayBuffer;
        try {
          data = encodeWireMessage({ leg: 'event', id, method, event } as WireMessage);
        } catch (error) {
          finish(toError(error));
          return;
        }
        provider.post(data);
      },
      end(error?: Error) {
        finish(error ?? null);
      },
    };
    let stop: () => void;
    try {
      stop = handler(payload, contextOf(deadlineMs), sink);
    } catch (error) {
      finish(toError(error));
      return;
    }
    if (isCurrent()) {
      entry.stop = stop;
    } else {
      // Ended, unsubscribed or disposed while the handler ran, before it could say how to stop.
      guarded(stop);
    }
  };

  const onUnsubscribe = (id: number, method: SubscriptionMethod): void => {
    const entry = running.get(id);
    if (entry?.method !== method) {
      return;
    }
    running.delete(id);
    if (entry.stop !== null) {
      guarded(entry.stop);
    }
  };

  const onMessage = (data: ArrayBuffer): void => {
    const message = receive(data, count, side);
    if (message === null) {
      return;
    }
    switch (message.leg) {
      case 'request':
        if (message.method === 'handshake') {
          onHandshake(message.id, message.payload);
        } else {
          onRequest(message.id, message.method, message.deadlineMs, message.payload);
        }
        return;
      case 'subscribe':
        onSubscribe(message.id, message.method, message.deadlineMs, message.payload);
        return;
      case 'unsubscribe':
        onUnsubscribe(message.id, message.method);
        return;
      case 'response':
      case 'event':
      case 'end':
        // A serving end calls nothing, so an answer or event from the peer belongs to no call here.
        return;
    }
  };
  // Providers do not buffer, so the listener is bound before anything can arrive.
  const unsubscribeProvider = provider.subscribe(onMessage);

  return {
    handleRequest(method, handler) {
      if (requestHandlers.has(method)) {
        throw new Error(`${method} already has a handler`);
      }
      const loose = handler as LooseRequestHandler;
      requestHandlers.set(method, loose);
      return () => {
        if (requestHandlers.get(method) === loose) {
          requestHandlers.delete(method);
        }
      };
    },

    handleSubscription(method, handler) {
      if (subscriptionHandlers.has(method)) {
        throw new Error(`${method} already has a handler`);
      }
      const loose = handler as unknown as LooseSubscriptionHandler;
      subscriptionHandlers.set(method, loose);
      return () => {
        if (subscriptionHandlers.get(method) === loose) {
          subscriptionHandlers.delete(method);
        }
      };
    },

    dispose(reason) {
      if (disposed) {
        return;
      }
      disposed = true;
      const entries = [...running];
      running.clear();
      for (const [id, entry] of entries) {
        if (entry.stop !== null) {
          guarded(entry.stop);
        }
        postLeaving(provider, { leg: 'end', id, method: entry.method, error: toWireError(reason) });
      }
      unsubscribeProvider();
      provider.dispose();
    },
  };
}
