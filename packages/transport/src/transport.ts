// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One transport per provider for the provider's whole life, the same on every side. It reads each frame and hands it to
// the handshake, to the calls this side makes, or to the calls it serves. Each side numbers its own calls, the opener
// odd and the accepter even, so a frame's id tells whose call it is about. The transport owns whether it is open, and
// everything it cannot handle goes to the owner's issue hook.

import { createAsyncTaskPool, deferred, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import type { Codec, ResultPayload } from 'scale-ts';
import {
  TransportHandshakeTimeoutError,
  TransportVersionMismatchError,
  cancelled,
  err,
  failureReason,
  hostFailure,
  logIssue,
  malformedFrame,
  ok,
  unsupported,
  type CallError,
  type Failure,
  type TransportIssue,
} from './errors.js';
import type { Provider } from './provider.js';
import { createRecentIds } from './recent-ids.js';
import {
  sameMethod,
  type Address,
  type AnyMethod,
  type Request,
  type Schema,
  type Subscription,
  type Sections,
} from './schema.js';
import { decode, encodeCall, encodeFrame, frame, type Accept, type Call, type Frame, type Open } from './wire.js';

/** What a subscriber hears: each value, then one end, unless it stops first. */
export interface SubscriptionListeners<V, I> {
  receive(value: V): void;
  /** The peer's end, a failure the library answered with, or `Cancelled` or `MalformedFrame` raised on this side. */
  interrupt(outcome: ResultPayload<undefined, CallError<I>>): void;
  /** The end raised on this side with an error: the transport closed, or the start could not be posted. */
  close(error: Error): void;
}

/** What a handler knows about the peer that called it. */
export interface CallContext<H> {
  /** The peer's origin when the call arrived, or null when it has none. */
  origin: string | null;
  /** The peer's handshake hello. */
  hello: H;
}

/** What a subscription handler sends on. Both do nothing once the subscription has ended. */
export interface Sink<V, I> {
  /** Sends a value. One the wire cannot carry ends the subscription with `HostFailure`. */
  receive(value: V): void;
  /** Ends the subscription with `outcome`, as the subscriber hears it: `ok()`, or an error a relay may pass on as is. */
  interrupt(outcome: ResultPayload<undefined, CallError<I>>): void;
}

/** Serves one request method. It answers with a `Result`, and a throw or rejection answers `HostFailure`. */
export type RequestHandler<P, R, E, H> = (
  payload: P,
  context: CallContext<H>,
) => ResultPayload<R, CallError<E>> | PromiseLike<ResultPayload<R, CallError<E>>>;

/**
 * Serves one subscription method. It starts the subscription, sends on the sink, and returns what stops it, which runs
 * once on the peer's stop, an interrupt or a dispose. A throw on start interrupts with `HostFailure`.
 */
export type SubscriptionHandler<S, V, I, H> = (start: S, context: CallContext<H>, sink: Sink<V, I>) => () => void;

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
   * Subscribes to the peer. `receive` hears each value, and `interrupt` or `close` the one end. Subscriptions made
   * before the handshake wait and go out in call order with the requests. Returns what stops it, which tells the peer
   * and calls no listener. Throws when the start does not encode.
   */
  subscribe<S, V, I>(
    method: Subscription<S, V, I>,
    start: NoInfer<S>,
    listeners: SubscriptionListeners<NoInfer<V>, NoInfer<I>>,
    options?: SubscribeOptions,
  ): () => void;
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

/** A call that went out, as the peer's messages reach it. */
interface OutCall {
  address: Address;
  hear(message: Uint8Array): void;
  fail(error: Failure): void;
  close(error: Error): void;
}

/** A method's handler, as the peer's calls reach it. */
type Served<H> = (id: number, message: Uint8Array, context: CallContext<H>) => void;

/** A subscription the peer opened, as its stop reaches it. */
interface Running {
  address: Address;
  hear(message: Uint8Array): void;
  end(error: Failure): void;
}

const DEFAULT_RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
// The largest id the wire's u32 carries. Ids wrap long after any call with an old one has settled.
const MAX_ID = 0xffff_ffff;

/** Fails a handshake attempt so the pool tries again. Any other failure ends the handshake. */
class HandshakeUnansweredError extends Error {}

export function createTransport<H, T extends Sections>(
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
  const opens = options.handshake === 'open';
  const firstId = opens ? 1 : 2;
  let lastId = firstId - 2;
  // Settles once the handshake succeeds or fails, or the transport closes. The phase says which.
  const handshakeOver = deferred<undefined>();

  const nextId = (): number => {
    lastId = lastId + 2 > MAX_ID ? firstId : lastId + 2;
    return lastId;
  };
  /** Whether call `id` is one this side made. */
  const ownCall = (id: number): boolean => id % 2 === firstId % 2;
  /** Reports a message that does not decode, or does not fit what it names. */
  const refuse = (reason: 'malformed' | 'invalid', cause: Error): void => {
    report({ kind: 'refused', reason, cause });
  };
  /** Runs a callback of the owner's. One that throws is reported as `listener_threw`, and the transport carries on. */
  const runListener = (listener: () => void): void => {
    try {
      listener();
    } catch (error) {
      report({ kind: 'listener_threw', error: toError(error) });
    }
  };
  /**
   * Posts bytes, of the call at `address` when they belong to one. A post the provider throws on is already reported
   * when it returns the error.
   */
  const post = (data: ArrayBuffer, address?: Address): ResultPayload<undefined, Error> => {
    try {
      provider.post(data);
      return ok();
    } catch (thrown) {
      const error = toError(thrown);
      const call = address === undefined ? undefined : { section: address.section, method: address.method };
      report({ kind: 'post_failed', error, call });
      return err(error);
    }
  };

  // The calls this side makes: requests and subscriptions. Each waits for the handshake to be over, then goes out. What
  // comes back carries the call's id, and the call decodes it with its own method's codec.

  // The calls that went out and wait for the peer.
  const out = new Map<number, OutCall>();
  const ended = createRecentIds();

  /**
   * Runs `send` once the handshake is over, or fails with the error the transport closed with. Each does nothing for a
   * call that ended meanwhile. Callbacks on one promise run in the order they were added, so calls go out in call order.
   */
  const place = (send: () => void, fail: (error: Error) => void): void => {
    void handshakeOver.promise.then(() => {
      if (phase.name === 'closed') {
        fail(phase.error);
      } else {
        send();
      }
    });
  };

  /** Reports a message on a call this side is not waiting on, unless it ended that call lately. */
  const refuseStray = (id: number): void => {
    if (!ended.has(id)) {
      refuse('invalid', new Error(`A message names call ${String(id)}, which this side is not waiting on`));
    }
  };

  function request<P, R, E>(
    method: Request<P, R, E>,
    payload: P,
    { signal }: RequestOptions = {},
  ): Promise<ResultPayload<R, CallError<E>>> {
    const address = schema.addressOf(method);
    return new Promise<ResultPayload<R, CallError<E>>>((resolve, reject) => {
      // A closed transport is never a call outcome, so its error wins over an aborted signal.
      if (phase.name === 'closed') {
        reject(phase.error);
        return;
      }
      if (signal?.aborted === true) {
        resolve(err(cancelled()));
        return;
      }
      const id = nextId();
      let done = false;
      /** Ends the call once. Returns whether it was still going. */
      const leave = (): boolean => {
        if (done) {
          return false;
        }
        done = true;
        signal?.removeEventListener('abort', onAbort);
        if (out.delete(id)) {
          ended.add(id);
        }
        return true;
      };
      const answer = (outcome: ResultPayload<R, CallError<E>>): void => {
        if (leave()) {
          resolve(outcome);
        }
      };
      const abandon = (error: Error): void => {
        if (leave()) {
          reject(error);
        }
      };
      const onAbort = (): void => {
        answer(err(cancelled()));
      };
      const call: OutCall = {
        address,
        hear(bytes) {
          const message = decode(method.message, bytes);
          if (!message.success) {
            refuse('malformed', message.value);
            answer(err(malformedFrame(message.value)));
          } else if (message.value.tag === 'response') {
            answer(message.value.value);
          } else {
            refuse('invalid', new Error(`A request names call ${String(id)}, which this side made`));
          }
        },
        fail(error) {
          answer(err(error));
        },
        close: abandon,
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      place(() => {
        if (done) {
          return;
        }
        const data = encodeCall(method, address, id, { tag: 'request', value: payload });
        if (!data.success) {
          abandon(data.value);
          return;
        }
        out.set(id, call);
        const posted = post(data.value, address);
        if (!posted.success) {
          abandon(new Error('The request could not be posted', { cause: posted.value }));
        }
      }, abandon);
    });
  }

  function subscribe<S, V, I>(
    method: Subscription<S, V, I>,
    start: S,
    listeners: SubscriptionListeners<V, I>,
    { signal }: SubscribeOptions = {},
  ): () => void {
    const address = schema.addressOf(method);
    let state: 'queued' | 'open' | 'ended' = 'queued';
    const id = nextId();

    /** Ends the subscription once, and tells `heard`, if any. `tellPeer` stops an open one at the peer. */
    const finish = (tellPeer: boolean, heard: (() => void) | null): void => {
      const was = state;
      if (was === 'ended') {
        return;
      }
      state = 'ended';
      signal?.removeEventListener('abort', onAbort);
      out.delete(id);
      if (tellPeer && was === 'open') {
        ended.add(id);
        const data = encodeCall(method, address, id, { tag: 'stop', value: undefined });
        if (data.success) {
          post(data.value, address);
        }
      }
      if (heard !== null) {
        runListener(heard);
      }
    };
    const end = (outcome: ResultPayload<undefined, CallError<I>>, tellPeer: boolean): void => {
      finish(tellPeer, () => {
        listeners.interrupt(outcome);
      });
    };
    const shut = (error: Error): void => {
      finish(true, () => {
        listeners.close(error);
      });
    };
    const onAbort = (): void => {
      end(err(cancelled()), true);
    };

    const call: OutCall = {
      address,
      hear(bytes) {
        const message = decode(method.message, bytes);
        if (!message.success) {
          // What was lost may be a value, which leaves the subscriber behind the peer, so the subscription ends and the
          // peer is told to stop. A stop after the peer's own end is a race it drops.
          refuse('malformed', message.value);
          end(err(malformedFrame(message.value)), true);
          return;
        }
        const sent = message.value;
        switch (sent.tag) {
          case 'receive':
            runListener(() => {
              listeners.receive(sent.value);
            });
            return;
          case 'interrupt':
            end(sent.value, false);
            return;
          case 'start':
          case 'stop':
            refuse('invalid', new Error(`A ${sent.tag} names subscription ${String(id)}, which this side made`));
        }
      },
      fail(error) {
        end(err(error), false);
      },
      close: shut,
    };

    // Encoded at once, so a start the wire refuses throws to the caller. It is posted once, so the buffer stays whole.
    const data = encodeCall(method, address, id, { tag: 'start', value: start });
    if (!data.success) {
      throw data.value;
    }
    const stop = (): void => {
      finish(true, null);
    };
    if (signal?.aborted === true) {
      // Heard on a microtask, so no listener runs before the caller holds its stop.
      queueMicrotask(onAbort);
      return stop;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    place(() => {
      if (state !== 'queued') {
        return;
      }
      out.set(id, call);
      const posted = post(data.value, address);
      if (!posted.success) {
        shut(new Error('The start could not be posted', { cause: posted.value }));
        return;
      }
      // Open only once the start went out, so a stop from the issue hook of a failed post sees nothing the peer could
      // stop. A post that succeeds hears nothing before it returns.
      state = 'open';
    }, shut);
    return stop;
  }

  /** Hands a message the peer sent on call `id` to the call. */
  const hearOwn = (id: number, call: Call<Uint8Array>): void => {
    const outCall = out.get(id);
    if (outCall === undefined) {
      refuseStray(id);
      return;
    }
    if (!sameMethod(outCall.address, call)) {
      refuse('invalid', new Error(`A message for call ${String(id)} names another method than the call`));
      return;
    }
    outCall.hear(call.message);
  };

  /** Ends call `id` with a failure the peer answered it with. */
  const failOwn = (id: number, error: Failure): void => {
    const outCall = out.get(id);
    if (outCall === undefined) {
      refuseStray(id);
      return;
    }
    outCall.fail(error);
  };

  // The calls this side serves. Each method's handler decodes the peer's messages with the method's own codec, answers a
  // request with its `Result` and streams a subscription until one side ends it. The library's own outcomes, no handler, a
  // message that does not decode and a handler that throws, go back as a failure frame. Only calls the transport
  // admitted reach this side, once the handshake told who the peer is.

  const { onPeerIdle } = options;
  const handlers = new Map<AnyMethod, Served<H>>();
  // The peer's requests whose handlers have not settled, which a close answers.
  const inFlight = new Map<number, Address>();
  const running = new Map<number, Running>();
  // Runs the request handlers, so the wait for a peer that left is a wait for every call of its to settle. The pool
  // answers a handler that throws at once like one that rejects.
  const handlerCalls = createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY });
  const lateEnds = createRecentIds();
  // How many calls the peer has made so far. It only grows, so a wait that read it can tell whether the peer called
  // again since.
  let peerCalls = 0;
  // The count `onPeerIdle` last fired at, so one departure fires it once and the peer's next call arms it again.
  let idleHeardAt: number | null = null;

  /** Stores one handler per method, and returns what unregisters it. */
  const register = (method: AnyMethod, address: Address, served: Served<H>): (() => void) => {
    if (handlers.has(method)) {
      throw new Error(`${address.section}.${address.method} already has a handler`);
    }
    handlers.set(method, served);
    return () => {
      if (handlers.get(method) === served) {
        handlers.delete(method);
      }
    };
  };

  /** Answers call `id` with a failure of the library's own. */
  const postFailed = (id: number, error: Failure, address?: Address): void => {
    post(encodeFrame(frame, { id, body: { tag: 'failed', value: error } }), address);
  };

  /** Answers a call whose message does not decode. */
  const malformed = (id: number, cause: Error, address: Address): void => {
    refuse('malformed', cause);
    postFailed(id, malformedFrame(cause), address);
  };

  /** Tells `onPeerIdle` once the peer's calls have settled, unless it called again meanwhile or the transport closed. */
  const whenPeerIdle = async (seen: number): Promise<void> => {
    await handlerCalls.settle();
    if (phase.name === 'closed' || peerCalls !== seen || idleHeardAt === seen || onPeerIdle === undefined) {
      return;
    }
    idleHeardAt = seen;
    runListener(onPeerIdle);
  };

  /** The peer's own stop leaves nothing it opened running, even when this side ended a subscription before it came. */
  const onPeerStop = (): void => {
    if (running.size === 0) {
      void whenPeerIdle(peerCalls);
    }
  };

  /** Sends `message` on call `id`, or answers `HostFailure` for one the wire cannot carry. */
  function reply<M>(method: { readonly frame: Codec<Frame<M>> }, address: Address, id: number, message: M): void {
    const data = encodeCall(method, address, id, message);
    if (!data.success) {
      postFailed(id, hostFailure(data.value), address);
      return;
    }
    post(data.value, address);
  }

  function handleRequest<P, R, E>(method: Request<P, R, E>, handler: RequestHandler<P, R, E, H>): () => void {
    const address = schema.addressOf(method);
    return register(method, address, (id, bytes, context) => {
      const message = decode(method.message, bytes);
      if (!message.success) {
        malformed(id, message.value, address);
        return;
      }
      if (message.value.tag !== 'request') {
        refuse('invalid', new Error(`A response names call ${String(id)}, which the peer made`));
        return;
      }
      const payload = message.value.value;
      inFlight.set(id, address);
      void handlerCalls
        .call(() => handler(payload, context))
        .then(
          outcome => {
            // A close answered the call already.
            if (inFlight.delete(id)) {
              reply(method, address, id, { tag: 'response', value: outcome });
            }
          },
          (error: unknown) => {
            if (inFlight.delete(id)) {
              postFailed(id, hostFailure(toError(error)), address);
            }
          },
        );
    });
  }

  function handleSubscription<S, V, I>(
    method: Subscription<S, V, I>,
    handler: SubscriptionHandler<S, V, I, H>,
  ): () => void {
    const address = schema.addressOf(method);

    /** Runs the handler, and keeps the subscription running until either side ends it. */
    const start = (id: number, startValue: S, context: CallContext<H>): void => {
      let stop: (() => void) | null = null;
      const runStop = (): void => {
        if (stop !== null) {
          runListener(stop);
        }
      };

      /**
       * Ends the subscription once: `send` tells the peer, then the stop function runs. The peer hears it first, so a
       * stop function that disposes the transport cannot keep it from the peer.
       */
      const finish = (send: () => void): void => {
        if (running.get(id) !== entry) {
          return;
        }
        running.delete(id);
        lateEnds.add(id);
        send();
        runStop();
      };

      const entry: Running = {
        address,
        hear(bytes) {
          const message = decode(method.message, bytes);
          if (!message.success) {
            refuse('malformed', message.value);
            return;
          }
          if (message.value.tag !== 'stop') {
            refuse('invalid', new Error(`A ${message.value.tag} names subscription ${String(id)}, which is running`));
            return;
          }
          running.delete(id);
          runStop();
          onPeerStop();
        },
        end(error) {
          finish(() => {
            postFailed(id, error, address);
          });
        },
      };
      running.set(id, entry);

      const sink: Sink<V, I> = {
        receive(value) {
          if (running.get(id) !== entry) {
            return;
          }
          const data = encodeCall(method, address, id, { tag: 'receive', value });
          if (!data.success) {
            entry.end(hostFailure(data.value));
            return;
          }
          post(data.value, address);
        },
        interrupt(outcome) {
          finish(() => {
            reply(method, address, id, { tag: 'interrupt', value: outcome });
          });
        },
      };
      let stopIt: () => void;
      try {
        stopIt = handler(startValue, context, sink);
      } catch (error) {
        entry.end(hostFailure(toError(error)));
        return;
      }
      if (running.get(id) === entry) {
        stop = stopIt;
      } else {
        // Ended while the handler ran, before it could say how to stop.
        runListener(stopIt);
      }
    };

    return register(method, address, (id, bytes, context) => {
      const message = decode(method.message, bytes);
      if (!message.success) {
        malformed(id, message.value, address);
        return;
      }
      const sent = message.value;
      if (sent.tag !== 'start') {
        refuse('invalid', new Error(`A ${sent.tag} names subscription ${String(id)}, which is not running`));
        return;
      }
      start(id, sent.value, context);
    });
  }

  /** Hands a message of the peer's call `id` to what serves it. */
  const hearPeer = (id: number, call: Call<Uint8Array>, context: CallContext<H>): void => {
    const entry = running.get(id);
    if (entry !== undefined) {
      if (!sameMethod(entry.address, call)) {
        refuse('invalid', new Error(`A message for subscription ${String(id)} names another method`));
        return;
      }
      entry.hear(call.message);
      return;
    }
    if (lateEnds.has(id)) {
      // The peer stopped it before it heard this side's end. A second stop for it is no race.
      lateEnds.delete(id);
      onPeerStop();
      return;
    }
    // A new call, even one that does not decode or that names a method this side does not serve, tells that the peer
    // is here.
    peerCalls += 1;
    const method = schema.methodAt(call.sectionId, call.methodId);
    const served = method === undefined ? undefined : handlers.get(method);
    if (served === undefined) {
      postFailed(id, unsupported());
      return;
    }
    served(id, call.message, context);
  };

  /** Called once the peer is there, with its hello. */
  const onOpen = (peerHello: H): void => {
    if (phase.name !== 'connecting') {
      return;
    }
    phase = { name: 'connected', peerHello };
    handshakeOver.resolve(undefined);
  };
  const close = (error: Error): void => {
    if (phase.name === 'closed') {
      return;
    }
    phase = { name: 'closed', error };
    handshakeOver.resolve(undefined);
    // Every call in flight is answered with `HostFailure` carrying `error`, and every running subscription stops.
    const failure = hostFailure(error);
    for (const [id, address] of [...inFlight]) {
      postFailed(id, failure, address);
    }
    inFlight.clear();
    for (const entry of [...running.values()]) {
      entry.end(failure);
    }
    // Every call that went out and is still waiting rejects, and every subscription closes, telling the peer to stop
    // each open one. Calls still waiting for the handshake find the error as they leave.
    for (const outCall of [...out.values()]) {
      outCall.close(error);
    }
  };

  // One side opens the handshake and the other accepts it. The opener posts a fresh attempt every `retryMs` until an
  // answer comes or `timeoutMs` passes, since the accepter may not be listening yet. Each side settles the handshake
  // once, with whether the peer is there and what its hello is.

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timers = options.timers ?? realTimers;
  const attempts = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: options.retryMs ?? DEFAULT_RETRY_MS,
    retryIf: error => error instanceof HandshakeUnansweredError,
    timers,
  });
  const stopAttempts = new AbortController();
  let started = false;

  // Settles the opener's handshake once. An answer settles it in the turn it arrives, so a call the accepter makes right
  // after its answer finds this side open.
  const settleHandshake = (outcome: ResultPayload<H, Error>): void => {
    if (phase.name !== 'connecting') {
      return;
    }
    if (outcome.success) {
      stopAttempts.abort();
      onOpen(outcome.value);
    } else {
      stopAttempts.abort(outcome.value);
      close(outcome.value);
    }
  };

  // An attempt is no call, so it takes no call id, and the accepter's answer echoes it.
  const attempt = (): never => {
    const hello = schema.hello.enc(options.hello);
    const data = encodeFrame(frame, { id: 0, body: { tag: 'open', value: { version: schema.version, hello } } });
    const posted = post(data);
    if (!posted.success) {
      throw new Error('The handshake could not be posted', { cause: posted.value });
    }
    throw new HandshakeUnansweredError('The handshake is not answered yet');
  };

  const heardAccept = (accept: Accept): void => {
    if (!started) {
      refuse('invalid', new Error('A handshake answer came before this side opened the handshake'));
      return;
    }
    // Only the first answer counts. The rest answer attempts already in flight.
    if (!accept.success) {
      settleHandshake(err(new TransportVersionMismatchError(schema.version, accept.value.version)));
      return;
    }
    const hello = decode(schema.hello, accept.value);
    if (!hello.success) {
      refuse('malformed', hello.value);
      return;
    }
    settleHandshake(hello);
  };

  // The accepter's answer to the first attempt whose answer was posted, which every later attempt hears again.
  let first: Accept | undefined;

  const heardOpen = (id: number, open: Open): void => {
    const sameVersion = open.version === schema.version;
    const peerHello = sameVersion ? decode(schema.hello, open.hello) : undefined;
    if (peerHello?.success === false) {
      refuse('malformed', peerHello.value);
      return;
    }
    const deciding = first === undefined;
    let answer: Accept;
    try {
      answer = first ?? (sameVersion ? ok(schema.hello.enc(options.hello)) : err({ version: schema.version }));
    } catch (error) {
      close(new Error('The handshake answer could not be encoded', { cause: error }));
      return;
    }
    // An answer the opener never heard decides nothing, so its next attempt is answered afresh.
    const posted = post(encodeFrame(frame, { id, body: { tag: 'accept', value: answer } }));
    if (!posted.success || !deciding) {
      return;
    }
    first = answer;
    if (peerHello === undefined) {
      close(new TransportVersionMismatchError(schema.version, open.version));
    } else {
      onOpen(peerHello.value);
    }
  };

  const receive = (data: ArrayBuffer): void => {
    const received = decode(frame, data);
    if (!received.success) {
      refuse('malformed', received.value);
      return;
    }
    const { id, body } = received.value;
    switch (body.tag) {
      case 'open':
        if (opens) {
          refuse('invalid', new Error('A handshake open reached the side that opens the handshake'));
        } else {
          heardOpen(id, body.value);
        }
        return;
      case 'accept':
        if (opens) {
          heardAccept(body.value);
        } else {
          refuse('invalid', new Error('A handshake answer reached the side that accepts the handshake'));
        }
        return;
      case 'failed':
        failOwn(id, body.value);
        return;
      case 'call':
        if (ownCall(id)) {
          hearOwn(id, body.value);
        } else if (phase.name === 'connected') {
          hearPeer(id, body.value, { origin: provider.peerOrigin(), hello: phase.peerHello });
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
      if (!opens || started || stopAttempts.signal.aborted) {
        return;
      }
      started = true;
      // An attempt fails until an answer comes, so the pool posts a fresh one every `retryMs` until it is stopped. It
      // settles only when stopped, or when an attempt cannot encode its hello or be posted.
      const retrying = attempts.call<never>(attempt, { signal: stopAttempts.signal });
      withTimeout(
        retrying,
        timeoutMs,
        () => new TransportHandshakeTimeoutError(`No handshake answer within ${String(timeoutMs)} ms`),
        timers,
      ).catch((error: unknown) => {
        settleHandshake(err(toError(error)));
      });
    },

    async whenConnected() {
      await handshakeOver.promise;
      if (phase.name === 'closed') {
        throw phase.error;
      }
    },

    request,
    handleRequest,
    subscribe,
    handleSubscription,

    dispose(reason) {
      if (disposed) {
        return;
      }
      disposed = true;
      stopAttempts.abort(reason);
      close(reason);
      unsubscribeProvider();
      provider.dispose();
    },
  };
}
