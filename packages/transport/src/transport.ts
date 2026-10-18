// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One transport per provider for the provider's whole life, the same on every side. It reads each frame and hands it to
// the handshake, to the calls this side makes, or to the calls it serves. Each side numbers its own calls, the opener
// odd and the accepter even, so a frame's id tells whose call it is about. The transport owns whether it is open, and
// everything the parts cannot handle goes to the owner's issue hook.

import { realTimers, toError, type Timers } from '@dotli/shared';
import type { ResultPayload } from 'scale-ts';
import { createCalls, type SubscriptionHandle, type SubscriptionListeners } from './calls.js';
import { failureReason, logIssue, type TransportIssue } from './errors.js';
import { createAccepter, createOpener } from './handshake.js';
import type { Post, Refuse, RunListener } from './parts.js';
import type { Provider } from './provider.js';
import { err, ok, type CallError } from './result.js';
import type { Request, Schema, Subscription, Traits } from './schema.js';
import { createServing, type RequestHandler, type SubscriptionHandler } from './serving.js';
import { decode, frame } from './wire.js';

const DEFAULT_RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
// The largest id the wire's u32 carries. Ids wrap long after any call with an old one has settled.
const MAX_ID = 0xffff_ffff;

export interface TransportOptions<H> {
  /** Which side opens the handshake. The other accepts it. */
  handshake: 'open' | 'accept';
  /** This side's handshake value. */
  hello: H;
  /** How often the opener posts a fresh handshake until it is answered. */
  retryMs?: number | undefined;
  /** How long the opener waits for an answer, on the running clock. */
  timeoutMs?: number | undefined;
  timers?: Timers | undefined;
  /** Hears what the transport cannot handle itself. With none, each issue is logged as an error. */
  onIssue?: ((issue: TransportIssue) => void) | undefined;
  /**
   * Called when the peer's own stop leaves nothing it opened running and no request of the peer is in flight, which is
   * how a peer that disposes leaves. A live peer keeps at least one subscription open, so dropping to none is taken as
   * leaving. It fires once per departure. A call the peer makes after that cancels a wait and arms it again, even one
   * that does not decode or that names a method this side does not serve. Ends this side posted never count, since the
   * peer may not have heard them yet.
   */
  onPeerIdle?: (() => void) | undefined;
}

export interface RequestOptions {
  /** Gives up on the call: it resolves `Cancelled` and a late answer is ignored. The peer is not told. */
  signal?: AbortSignal;
}

export interface SubscribeOptions {
  /** Gives up on the subscription: the peer is told to stop and `interrupt` hears `Cancelled`, once. */
  signal?: AbortSignal;
}

/** Calls and serves the methods of one schema, whose hello is `H`. A method is passed as the schema holds it. */
export interface Transport<H> {
  /** Starts the handshake on the opener. Does nothing on the accepter, which waits for the opener. */
  connect(): void;
  /** Resolves once the handshake succeeds, and rejects with the closing error once the transport closes. */
  whenConnected(): Promise<void>;
  /**
   * Calls the peer. Resolves to its `Result`, or to `Cancelled` once the signal aborts. Calls made before the handshake
   * wait and go out in call order once it succeeds. Rejects only with the error the transport closed with, or when the
   * call cannot go out: a payload that does not encode or a post the provider throws on.
   */
  request<P, R, E>(
    method: Request<P, R, E>,
    payload: NoInfer<P>,
    options?: RequestOptions,
  ): Promise<ResultPayload<R, CallError<E>>>;
  /** Serves one method. One handler per method, and calling the returned function unregisters it. */
  handleRequest<P, R, E>(
    method: Request<P, R, E>,
    handler: RequestHandler<NoInfer<P>, NoInfer<R>, NoInfer<E>, H>,
  ): () => void;
  /**
   * Subscribes to the peer. `receive` hears each value and `interrupt` the one end. Subscriptions made before the
   * handshake wait and go out in call order with the requests. Throws when the start does not encode.
   */
  subscribe<S, V, I>(
    method: Subscription<S, V, I>,
    start: NoInfer<S>,
    listeners: SubscriptionListeners<NoInfer<V>, NoInfer<I>>,
    options?: SubscribeOptions,
  ): SubscriptionHandle;
  /** Serves one subscription method. One handler per method, and calling the returned function unregisters it. */
  handleSubscription<S, V, I>(
    method: Subscription<S, V, I>,
    handler: SubscriptionHandler<NoInfer<S>, NoInfer<V>, NoInfer<I>, H>,
  ): () => void;
  /**
   * Closes this side. Every subscription it serves is interrupted with `HostFailure` carrying `reason`, every one it
   * made is stopped at the peer and hears `onClose(reason)`, every pending and later request rejects with `reason`, and
   * the provider is disposed.
   */
  dispose(reason: Error): void;
}

type Phase<H> = { name: 'connecting' } | { name: 'connected'; peerHello: H } | { name: 'closed'; error: Error };

export function createTransport<H, T extends Traits>(
  schema: Schema<H, T>,
  provider: Provider,
  options: TransportOptions<H>,
): Transport<H> {
  // The owner's hook must not throw into a provider's listener, so a throw is logged with the issue it was handed.
  const report = (issue: TransportIssue): void => {
    if (options.onIssue === undefined) {
      logIssue(issue);
      return;
    }
    try {
      options.onIssue(issue);
    } catch (error) {
      logIssue(issue);
      logIssue({
        kind: 'listener_threw',
        error: new Error(`The issue hook threw, ${failureReason(toError(error))}`, { cause: error }),
      });
    }
  };

  let phase: Phase<H> = { name: 'connecting' };
  let disposed = false;
  const firstId = options.handshake === 'open' ? 1 : 2;
  let lastId = firstId - 2;
  let endHandshake = (): void => undefined;
  // Settles once the handshake succeeds or fails, or the transport closes. The phase says which.
  const handshakeOver = new Promise<void>(resolve => {
    endHandshake = resolve;
  });

  const nextId = (): number => {
    lastId = lastId + 2 > MAX_ID ? firstId : lastId + 2;
    return lastId;
  };
  /** Whether call `id` is one this side made. */
  const ownCall = (id: number): boolean => id % 2 === firstId % 2;
  const closedBy = (): Error | null => (phase.name === 'closed' ? phase.error : null);
  const refuse: Refuse = (reason, cause) => {
    report({ kind: 'refused', reason, cause });
  };
  const runListener: RunListener = listener => {
    try {
      listener();
    } catch (error) {
      report({ kind: 'listener_threw', error: toError(error) });
    }
  };
  const post: Post = (data, address) => {
    try {
      provider.post(data);
      return ok();
    } catch (thrown) {
      const error = toError(thrown);
      const call = address === undefined ? undefined : { trait: address.trait, method: address.method };
      report({ kind: 'post_failed', error, call });
      return err(error);
    }
  };
  const { addressOf } = schema;

  const calls = createCalls({
    nextId,
    post,
    handshakeOver,
    closedBy,
    refuse,
    runListener,
  });
  const serving = createServing<H>({
    methodAt: schema.methodAt,
    post,
    closed: () => phase.name === 'closed',
    refuse,
    runListener,
    onPeerIdle: options.onPeerIdle,
  });

  const onOpen = (peerHello: H): void => {
    if (phase.name !== 'connecting') {
      return;
    }
    phase = { name: 'connected', peerHello };
    endHandshake();
  };
  const close = (error: Error): void => {
    if (phase.name === 'closed') {
      return;
    }
    phase = { name: 'closed', error };
    endHandshake();
    serving.close(error);
    calls.close(error);
  };

  const handshakeDeps = {
    version: schema.version,
    helloCodec: schema.hello,
    hello: options.hello,
    post,
    refuse,
    onOpen,
    onFail: close,
  };
  const opener =
    options.handshake === 'open'
      ? createOpener({
          ...handshakeDeps,
          retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          timers: options.timers ?? realTimers,
        })
      : null;
  const handshake = opener ?? createAccepter(handshakeDeps);

  const receive = (data: ArrayBuffer): void => {
    const received = decode(frame, data);
    if (!received.success) {
      refuse('malformed', received.value);
      return;
    }
    const { id, body } = received.value;
    switch (body.tag) {
      case 'open':
        handshake.heardOpen(id, body.value);
        return;
      case 'accept':
        handshake.heardAccept(body.value);
        return;
      case 'failed':
        calls.fail(id, body.value);
        return;
      case 'call':
        if (ownCall(id)) {
          calls.hear(id, body.value);
        } else if (phase.name === 'connected') {
          serving.hear(id, body.value, { origin: provider.peerOrigin(), hello: phase.peerHello });
        } else {
          // The peer acts on this side only once the handshake told who it is.
          const when =
            phase.name === 'connecting'
              ? 'before the handshake'
              : `after the transport closed, ${failureReason(phase.error)}`;
          refuse('invalid', new Error(`A call came ${when}`));
        }
    }
  };
  // Nothing thrown while a frame is handled reaches the provider, whose other listeners must still hear it.
  const onData = (data: ArrayBuffer): void => {
    try {
      receive(data);
    } catch (error) {
      refuse('invalid', new Error('The message could not be handled', { cause: error }));
    }
  };
  // Providers do not buffer, so the listener is bound before anything can arrive.
  const unsubscribeProvider = provider.subscribe(onData);

  return {
    connect() {
      opener?.start();
    },

    async whenConnected() {
      await handshakeOver;
      const closed = closedBy();
      if (closed !== null) {
        throw closed;
      }
    },

    request(method, payload, requestOptions = {}) {
      return calls.request(method, addressOf(method), payload, requestOptions.signal);
    },

    handleRequest(method, handler) {
      return serving.handleRequest(method, addressOf(method), handler);
    },

    subscribe(method, start, listeners, subscribeOptions = {}) {
      return calls.subscribe(method, addressOf(method), start, listeners, subscribeOptions.signal);
    },

    handleSubscription(method, handler) {
      return serving.handleSubscription(method, addressOf(method), handler);
    },

    dispose(reason) {
      if (disposed) {
        return;
      }
      disposed = true;
      opener?.stop(reason);
      close(reason);
      unsubscribeProvider();
      provider.dispose();
    },
  };
}
