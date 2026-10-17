// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The serving end of a transport, one per provider for the provider's whole life. It answers the handshake itself and
// runs the handler registered for each method.

import { m } from '@dotli/metrics';
import { toError } from '@dotli/shared';
import { ProtocolVersionMismatchError } from './errors.js';
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
import { encodeWireMessage, toWireError, type WireMessage } from './wire-message.js';

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

function unhandled(method: ProtocolMethod): Error {
  return new Error(`This end does not handle ${method}`);
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
