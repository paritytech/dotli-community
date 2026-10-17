// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The consumer end of a transport, one per provider for the provider's whole life. It handshakes, holds calls until
// the handshake is answered, and matches answers and legs to its calls by id. Every post encodes a fresh buffer, since
// a transferred one is detached.

import { m } from '@dotli/metrics';
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
import { guarded, postLeaving, receive, type Count } from './transport-shared.js';
import { encodeWireMessage, type WireError, type WireMessage } from './wire-message.js';

const DEFAULT_RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
// The largest id the wire's u32 carries. Ids wrap long after any call with an old one has settled.
const MAX_ID = 0xffff_ffff;

export interface CallOptions {
  /** When the caller stops waiting, in ms since the epoch. The serving handler reads it to size its own budget. */
  deadlineMs?: number;
  /**
   * Gives up on the call: it rejects or ends with the signal's reason and a late answer is ignored. Nothing tells the
   * serving side about a request, while an open subscription is unsubscribed.
   */
  signal?: AbortSignal;
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

/** A remote failure as a local error. The remote class name and stack travel as fields of it. */
function fromWire(error: WireError, method: ProtocolMethod): Error {
  if (method === 'handshake' && error.name === 'ProtocolVersionMismatchError') {
    return new ProtocolVersionMismatchError(error.message);
  }
  return new ProtocolRequestError(error.message, error.name ?? 'Error', method, error.stack ?? undefined);
}

/** Fails a handshake attempt so the pool tries again. Any other failure ends the handshake. */
class HandshakeUnansweredError extends Error {}

/** Calls `onAbort` once the signal aborts, until the returned detach runs. */
function onAborted(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (signal === undefined) {
    return () => undefined;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
  };
}

interface RequestCall {
  kind: 'request';
  id: number;
  method: RequestMethod;
  payload: unknown;
  deadlineMs: number | null;
  resolve: (answer: unknown) => void;
  reject: (error: Error) => void;
}

interface SubscriptionCall {
  kind: 'subscription';
  id: number;
  method: SubscriptionMethod;
  payload: unknown;
  deadlineMs: number | null;
  onEvent: (event: unknown) => void;
  endListeners: ((error: Error | null) => void)[];
  /** Stops listening to the call's signal. */
  detach: () => void;
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
    retryIf: error => error instanceof HandshakeUnansweredError,
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
    call.detach();
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
        call.reject(toError(error));
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
        call.reject(toError(error));
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
        call.reject(toError(error));
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
          try {
            postHandshake();
          } catch (error) {
            throw new Error('The handshake could not be posted', { cause: error });
          }
          throw new HandshakeUnansweredError('The handshake is not answered yet');
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
        const { signal } = callOptions;
        const closed = signal?.aborted === true ? toError(signal.reason) : closedBy();
        if (closed !== null) {
          reject(closed);
          return;
        }
        const call: RequestCall = {
          kind: 'request',
          id: nextId(),
          method,
          payload,
          deadlineMs: callOptions.deadlineMs ?? null,
          resolve: answer => {
            detach();
            resolve(answer as Answer<typeof method>);
          },
          reject: error => {
            detach();
            reject(error);
          },
        };
        const detach = onAborted(signal, () => {
          const index = queue.indexOf(call);
          if (index >= 0) {
            queue.splice(index, 1);
          }
          waiting.delete(call.id);
          call.reject(toError(signal?.reason));
        });
        place(call);
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
        detach: () => undefined,
        state: { name: 'queued' },
      };
      const { signal } = callOptions;
      const closed = signal?.aborted === true ? toError(signal.reason) : closedBy();
      if (closed !== null) {
        call.state = { name: 'ended', error: closed };
      } else {
        call.detach = onAborted(signal, () => {
          if (call.state.name === 'open') {
            postLeaving(provider, { leg: 'unsubscribe', id: call.id, method: call.method });
          }
          end(call, toError(signal?.reason));
        });
        place(call);
      }
      return {
        unsubscribe() {
          const was = call.state.name;
          if (was === 'ended' || was === 'unsubscribed') {
            return;
          }
          forget(call);
          call.detach();
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
