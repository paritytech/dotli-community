// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side serves. Each method's handler decodes the peer's messages with the method's own codec, answers a
// request with its `Result` and streams a subscription until one side ends it. The library's own outcomes, no handler, a
// message that does not decode and a handler that throws, go back as a failure frame. The transport hands this side
// only calls it admitted, once the handshake told who the peer is.

import { createAsyncTaskPool, toError } from '@dotli/shared';
import type { Codec, ResultPayload } from 'scale-ts';
import {
  REMEMBERED_ENDS,
  createRecentIds,
  encodeCall,
  sameMethod,
  type Post,
  type Refuse,
  type RunListener,
} from './parts.js';
import { hostFailure, malformedFrame, unsupported, type CallError, type Failure } from './result.js';
import type { Address, AnyMethod, Place, Request, Subscription } from './schema.js';
import { decode, encodeFrame, frame, type Call, type Frame } from './wire.js';

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

export interface ServingDeps {
  /** The method at a place in the schema, and its address. */
  placeAt: (traitId: number, methodId: number) => Place | undefined;
  post: Post;
  /** Whether the transport has closed, after which the peer hears no answer. */
  closed: () => boolean;
  refuse: Refuse;
  runListener: RunListener;
  /** Hears that the peer left: its own stop left nothing running, and its calls have settled. Once per departure. */
  onPeerIdle: (() => void) | undefined;
}

export interface Serving<H> {
  /** One handler per method. Returns what unregisters it. */
  handleRequest<P, R, E>(method: Request<P, R, E>, address: Address, handler: RequestHandler<P, R, E, H>): () => void;
  handleSubscription<S, V, I>(
    method: Subscription<S, V, I>,
    address: Address,
    handler: SubscriptionHandler<S, V, I, H>,
  ): () => void;
  /** Hands a message of the peer's call `id` to what serves it. */
  hear(id: number, call: Call<Uint8Array>, context: CallContext<H>): void;
  /** Answers every call in flight with `HostFailure` carrying `error`, and stops every running subscription. */
  close(error: Error): void;
}

/** A method's handler, as the peer's calls reach it. */
interface Served<H> {
  hear(id: number, message: Uint8Array, context: CallContext<H>): void;
}

/** A subscription the peer opened, as its stop reaches it. */
interface Running {
  address: Address;
  hear(message: Uint8Array): void;
  end(error: Failure): void;
}

export function createServing<H>(deps: ServingDeps): Serving<H> {
  const { placeAt, post, closed, refuse, runListener, onPeerIdle } = deps;
  const handlers = new Map<AnyMethod, Served<H>>();
  // The peer's requests whose handlers have not settled, which a close answers.
  const inFlight = new Map<number, Address>();
  const running = new Map<number, Running>();
  // Runs the request handlers, so the wait for a peer that left is a wait for every call of its to settle. The pool
  // answers a handler that throws at once like one that rejects.
  const handlerCalls = createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY });
  const lateEnds = createRecentIds(REMEMBERED_ENDS);
  // How many calls the peer has made so far. It only grows, so a wait that read it can tell whether the peer called
  // again since.
  let peerCalls = 0;
  // The count `onPeerIdle` last fired at, so one departure fires it once and the peer's next call arms it again.
  let idleHeardAt: number | null = null;

  /** Stores one handler per method, and returns what unregisters it. */
  const register = (method: AnyMethod, address: Address, served: Served<H>): (() => void) => {
    if (handlers.has(method)) {
      throw new Error(`${address.trait}.${address.method} already has a handler`);
    }
    handlers.set(method, served);
    return () => {
      if (handlers.get(method) === served) {
        handlers.delete(method);
      }
    };
  };

  /** Answers call `id` with a failure of the library's own. */
  const fail = (id: number, error: Failure, address?: Address): void => {
    post(encodeFrame(frame, { id, body: { tag: 'failed', value: error } }), address);
  };

  /** Answers a call whose message does not decode. */
  const malformed = (id: number, cause: Error, address: Address): void => {
    refuse('malformed', cause);
    fail(id, malformedFrame(cause), address);
  };

  /** Tells `onPeerIdle` once the peer's calls have settled, unless it called again meanwhile or the transport closed. */
  const whenPeerIdle = async (seen: number): Promise<void> => {
    await handlerCalls.settle();
    if (closed() || peerCalls !== seen || idleHeardAt === seen || onPeerIdle === undefined) {
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

  /** Whether request `id` still waits for its answer. One whose handler settles once the transport closed has it. */
  const settles = (id: number): boolean => inFlight.delete(id) && !closed();

  /** Sends `message` on call `id`, or answers `HostFailure` for one the wire cannot carry. */
  function answer<M>(method: { readonly frame: Codec<Frame<M>> }, address: Address, id: number, message: M): void {
    const data = encodeCall(method, address, id, message);
    if (!data.success) {
      fail(id, hostFailure(data.value), address);
      return;
    }
    post(data.value, address);
  }

  /** Runs a subscription's handler, and keeps it running until either side ends it. */
  function start<S, V, I>(
    method: Subscription<S, V, I>,
    address: Address,
    handler: SubscriptionHandler<S, V, I, H>,
    id: number,
    startValue: S,
    context: CallContext<H>,
  ): void {
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
          fail(id, error, address);
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
          answer(method, address, id, { tag: 'interrupt', value: outcome });
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
  }

  return {
    handleRequest(method, address, handler) {
      return register(method, address, {
        hear(id, bytes, context) {
          // A call that does not decode still tells that the peer is here.
          peerCalls += 1;
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
                if (settles(id)) {
                  answer(method, address, id, { tag: 'response', value: outcome });
                }
              },
              (error: unknown) => {
                if (settles(id)) {
                  fail(id, hostFailure(toError(error)), address);
                }
              },
            );
        },
      });
    },

    handleSubscription(method, address, handler) {
      return register(method, address, {
        hear(id, bytes, context) {
          const message = decode(method.message, bytes);
          if (!message.success) {
            peerCalls += 1;
            malformed(id, message.value, address);
            return;
          }
          const sent = message.value;
          if (sent.tag !== 'start') {
            refuse('invalid', new Error(`A ${sent.tag} names subscription ${String(id)}, which is not running`));
            return;
          }
          peerCalls += 1;
          start(method, address, handler, id, sent.value, context);
        },
      });
    },

    hear(id, call, context) {
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
      const placed = placeAt(call.trait, call.method);
      const served = placed === undefined ? undefined : handlers.get(placed.method);
      if (served === undefined) {
        peerCalls += 1;
        fail(id, unsupported());
        return;
      }
      served.hear(id, call.message, context);
    },

    close(error) {
      const failure = hostFailure(error);
      for (const [id, address] of [...inFlight]) {
        fail(id, failure, address);
      }
      inFlight.clear();
      for (const entry of [...running.values()]) {
        entry.end(failure);
      }
    },
  };
}
