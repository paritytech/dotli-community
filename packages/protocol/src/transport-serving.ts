// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The serving end of a transport, one per provider for the provider's whole life. It answers the handshake itself and
// runs the handler registered for each method.

import { captureException, m, spans as S } from '@dotli/metrics';
import { errorName, log, toError } from '@dotli/shared';
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
import { defaultReport, guarded, postLeaving, receive, type Count, type Report } from './transport-shared.js';
import {
  encodeWireMessage,
  toWireError,
  type Requestable,
  type RequestMessage,
  type ResponseOutcome,
  type SubscribeMessage,
} from './wire-message.js';

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

interface Running {
  method: SubscriptionMethod;
  /** Null until the handler returns it. */
  stop: (() => void) | null;
}

interface ServingTransportOptions {
  count?: Count;
  /** Hears what a subscription's stop function throws. */
  report?: Report;
  side: 'frame' | 'worker';
  /**
   * Called when the peer has unsubscribed its last running subscription and no call of its is still in flight, which
   * is how a consumer that disposes leaves. Not called for subscriptions this end ended, whose ends the peer may not
   * have heard yet.
   */
  onPeerIdle?: () => void;
}

export function createServingTransport(provider: Provider, options: ServingTransportOptions): ServingTransport {
  const { side } = options;
  const count = options.count ?? m.count;
  const report = options.report ?? defaultReport;
  // Each handler is stored under the method it was registered for, which the typed lookups below rely on.
  const requestHandlers = new Map<RequestMethod, unknown>();
  const subscriptionHandlers = new Map<SubscriptionMethod, unknown>();
  const running = new Map<number, Running>();
  let resolutionId: string | null = null;
  let disposed = false;
  // Requests whose handler has not settled, and whether the peer's own unsubscribe left nothing running.
  let inFlight = 0;
  let peerLeft = false;

  const checkIdle = (): void => {
    if (disposed || !peerLeft || running.size > 0 || inFlight > 0) {
      return;
    }
    peerLeft = false;
    if (options.onPeerIdle !== undefined) {
      guarded(report, options.onPeerIdle);
    }
  };

  const requestHandler = <M extends RequestMethod>(method: M): RequestHandler<M> | undefined =>
    requestHandlers.get(method) as RequestHandler<M> | undefined;
  const subscriptionHandler = <M extends SubscriptionMethod>(method: M): SubscriptionHandler<M> | undefined =>
    subscriptionHandlers.get(method) as SubscriptionHandler<M> | undefined;

  const contextOf = (deadlineMs: number | null): CallContext => ({
    origin: provider.peerOrigin(),
    deadlineMs,
    resolutionId,
  });

  /**
   * Posts an answer, an event or an end. One that throws is reported here, since an answer settles outside any caller
   * and a handler's `send` or `end` must not throw into it.
   */
  const post = (method: ProtocolMethod, data: ArrayBuffer): void => {
    try {
      provider.post(data);
    } catch (error) {
      captureException(error, { flow: 'protocol', step: 'serve_post', tags: { method, side } });
      log.error(`[dot.li] A ${method} message could not be posted`, error);
      count(S.PROTOCOL_SERVE_POST, { outcome: 'error', reason: errorName(error) ?? 'unknown', side });
    }
  };

  const respond = <M extends Requestable>(
    id: number,
    method: M,
    outcome: { ok: true; answer: Answer<M> } | { ok: false; error: unknown },
  ): void => {
    if (disposed) {
      // A handler that settles after the dispose has no peer left to hear it.
      log.event('protocol answer after dispose', {
        flow: 'protocol',
        method,
        side,
        outcome: outcome.ok ? 'ok' : 'error',
      });
      return;
    }
    const answer = (wireOutcome: ResponseOutcome<M>): ArrayBuffer =>
      encodeWireMessage({ leg: 'response', id, method, outcome: wireOutcome });
    let data: ArrayBuffer;
    try {
      data = answer(outcome.ok ? outcome : { ok: false, error: toWireError(outcome.error) });
    } catch (error) {
      data = answer({ ok: false, error: toWireError(error) });
    }
    post(method, data);
  };

  const postEnd = (id: number, method: SubscriptionMethod, error: Error | null): void => {
    post(method, encodeWireMessage({ leg: 'end', id, method, error: error === null ? null : toWireError(error) }));
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

  const onRequest = <M extends RequestMethod>({ id, method, deadlineMs, payload }: RequestMessage<M>): void => {
    const handler = requestHandler(method);
    if (handler === undefined) {
      respond(id, method, { ok: false, error: unhandled(method) });
      return;
    }
    inFlight += 1;
    const settled = (): void => {
      inFlight -= 1;
      checkIdle();
    };
    // A handler that throws at once answers like one that rejects.
    void new Promise<Answer<M>>(resolve => {
      resolve(handler(payload, contextOf(deadlineMs)));
    }).then(
      answer => {
        respond(id, method, { ok: true, answer });
        settled();
      },
      (error: unknown) => {
        respond(id, method, { ok: false, error });
        settled();
      },
    );
  };

  const onSubscribe = <M extends SubscriptionMethod>({
    id,
    method,
    deadlineMs,
    payload,
  }: SubscribeMessage<M>): void => {
    if (running.has(id)) {
      return;
    }
    const handler = subscriptionHandler(method);
    if (handler === undefined) {
      postEnd(id, method, unhandled(method));
      return;
    }
    const entry: Running = { method, stop: null };
    running.set(id, entry);
    peerLeft = false;
    const isCurrent = (): boolean => running.get(id) === entry;
    const finish = (error: Error | null): void => {
      if (!isCurrent()) {
        return;
      }
      running.delete(id);
      if (entry.stop !== null) {
        guarded(report, entry.stop);
      }
      postEnd(id, method, error);
    };
    const sink: SubscriptionSink<M> = {
      send(event) {
        if (!isCurrent()) {
          return;
        }
        let data: ArrayBuffer;
        try {
          data = encodeWireMessage({ leg: 'event', id, method, event });
        } catch (error) {
          finish(toError(error));
          return;
        }
        post(method, data);
      },
      end(error) {
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
      guarded(report, stop);
    }
  };

  const onUnsubscribe = (id: number, method: SubscriptionMethod): void => {
    const entry = running.get(id);
    if (entry?.method !== method) {
      return;
    }
    running.delete(id);
    if (entry.stop !== null) {
      guarded(report, entry.stop);
    }
    if (running.size === 0) {
      peerLeft = true;
      checkIdle();
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
          onRequest(message);
        }
        return;
      case 'subscribe':
        onSubscribe(message);
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
      requestHandlers.set(method, handler);
      return () => {
        if (requestHandlers.get(method) === handler) {
          requestHandlers.delete(method);
        }
      };
    },

    handleSubscription(method, handler) {
      if (subscriptionHandlers.has(method)) {
        throw new Error(`${method} already has a handler`);
      }
      subscriptionHandlers.set(method, handler);
      return () => {
        if (subscriptionHandlers.get(method) === handler) {
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
          guarded(report, entry.stop);
        }
        postLeaving(provider, { leg: 'end', id, method: entry.method, error: toWireError(reason) });
      }
      unsubscribeProvider();
      provider.dispose();
    },
  };
}
