// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The consumer end of a transport, one per provider for the provider's whole life. It handshakes, holds calls in a task
// pool until the handshake is over, and matches answers and legs to its calls by id. Every post encodes a fresh
// buffer, since a transferred one is detached.

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
import { defaultReport, guarded, postLeaving, receive, type Count, type Report } from './transport-shared.js';
import { encodeWireMessage, type WireError } from './wire-message.js';

const DEFAULT_RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
// The largest id the wire's u32 carries. Ids wrap long after any call with an old one has settled.
const MAX_ID = 0xffff_ffff;

export interface CallOptions {
  /** When the caller stops waiting, in ms since the epoch. The serving handler reads it to size its own budget. */
  deadlineMs?: number;
  /**
   * Gives up on the call: it rejects or ends with the signal's reason and a late answer is ignored. The reason is passed
   * on as it is when it is an `Error`, a `DOMException` included, and wrapped in one as its `cause` otherwise. Nothing
   * tells the serving side about a request, while an open subscription is unsubscribed.
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
  /** Hears what a subscription's event or end listener throws. */
  report?: Report;
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
  /** Encodes the call's leg when it is sent, so a payload the wire refuses fails the call then. */
  encode: () => ArrayBuffer;
  /** Aborted when the call settles, so a call settled while it waits leaves the pool and never goes out. */
  stop: AbortController;
  resolve: (answer: unknown) => void;
  reject: (error: Error) => void;
}

interface SubscriptionCall {
  kind: 'subscription';
  id: number;
  method: SubscriptionMethod;
  /** Encodes the call's leg when it is sent, so a payload the wire refuses ends the subscription then. */
  encode: () => ArrayBuffer;
  /** Aborted when the subscription ends or is unsubscribed, so one that waits leaves the pool and never goes out. */
  stop: AbortController;
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
  const report = options.report ?? defaultReport;

  let phase: Phase = { name: 'idle' };
  let lastId = 0;
  const waiting = new Map<number, RequestCall>();
  const open = new Map<number, SubscriptionCall>();
  let endHandshake = (): void => undefined;
  // Settles once the handshake succeeds or fails, or the transport is disposed. The phase says which.
  const handshakeOver = new Promise<void>(resolve => {
    endHandshake = resolve;
  });
  // Every call waits in this pool for the handshake to be over. It is unbounded, so calls run side by side once it is.
  // Each call is posted one step after it was made or after the handshake ended, whichever is later, so calls go out in
  // call order across the handshake, and a call made while the queue flushes goes out behind it.
  const calls = createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY });
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

  /** Takes a subscription out of the pool and the open map, wherever it still is. */
  const forget = (call: SubscriptionCall): void => {
    call.stop.abort();
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
      guarded(report, listener, error);
    }
  };

  /** Settles a call with why it ends. Settling one already settled changes nothing. */
  const fail = (call: Call, error: Error): void => {
    if (call.kind === 'request') {
      call.reject(error);
    } else {
      end(call, error);
    }
  };

  const send = (call: Call): void => {
    const { id } = call;
    let data: ArrayBuffer;
    try {
      data = call.encode();
    } catch (error) {
      fail(call, toError(error));
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
      waiting.delete(id);
      fail(call, toError(error));
    }
  };

  /** Sends the call once the handshake is over, or fails it with why the transport closed. */
  const place = (call: Call): void => {
    const { signal } = call.stop;
    calls
      .call(
        async () => {
          await handshakeOver;
          // The pool has already rejected a call stopped while it waited, and whatever stopped it settled it.
          if (signal.aborted) {
            return;
          }
          const closed = closedBy();
          if (closed !== null) {
            throw closed;
          }
          send(call);
        },
        { signal },
      )
      .catch((error: unknown) => {
        fail(call, toError(error));
      });
  };

  const onConnected = (): void => {
    stopHandshake.abort();
    if (phase.name !== 'connecting') {
      return;
    }
    phase = { name: 'connected' };
    endHandshake();
  };

  const onHandshakeFailed = (error: unknown): void => {
    stopHandshake.abort(error);
    if (phase.name !== 'connecting') {
      return;
    }
    phase = { name: 'failed', error: toError(error) };
    endHandshake();
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
          guarded(report, call.onEvent, message.event);
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

    async whenConnected() {
      await handshakeOver;
      const closed = closedBy();
      if (closed !== null) {
        throw closed;
      }
    },

    request(method, payload, callOptions = {}) {
      return new Promise((resolve, reject) => {
        const { signal } = callOptions;
        const closed = signal?.aborted === true ? toError(signal.reason) : closedBy();
        if (closed !== null) {
          reject(closed);
          return;
        }
        const id = nextId();
        const deadlineMs = callOptions.deadlineMs ?? null;
        const stop = new AbortController();
        const call: RequestCall = {
          kind: 'request',
          id,
          method,
          encode: () => encodeWireMessage({ leg: 'request', id, method, deadlineMs, payload }),
          stop,
          resolve: answer => {
            detach();
            stop.abort();
            resolve(answer as Answer<typeof method>);
          },
          reject: error => {
            detach();
            stop.abort();
            reject(error);
          },
        };
        const detach = onAborted(signal, () => {
          waiting.delete(call.id);
          call.reject(toError(signal?.reason));
        });
        place(call);
      });
    },

    subscribe<M extends SubscriptionMethod>(
      method: M,
      payload: SubscribePayload<M>,
      onEvent: (event: SubscriptionEvent<M>) => void,
      callOptions: CallOptions = {},
    ): Subscription {
      const id = nextId();
      const deadlineMs = callOptions.deadlineMs ?? null;
      const call: SubscriptionCall = {
        kind: 'subscription',
        id,
        method,
        encode: () => encodeWireMessage({ leg: 'subscribe', id, method, deadlineMs, payload }),
        stop: new AbortController(),
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
            guarded(report, listener, call.state.error);
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
      // A call still in the pool finds the transport closed once the handshake is over.
      endHandshake();
      const subscriptions = [...open.values()];
      const sent = [...waiting.values(), ...subscriptions];
      waiting.clear();
      open.clear();
      for (const call of subscriptions) {
        postLeaving(provider, { leg: 'unsubscribe', id: call.id, method: call.method });
      }
      unsubscribeProvider();
      provider.dispose();
      for (const call of sent) {
        fail(call, reason);
      }
    },
  };
}
