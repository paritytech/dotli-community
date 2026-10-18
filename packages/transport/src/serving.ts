// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side serves. It runs the handler registered for each method, answers a request with its `Result` and
// streams a subscription until one side ends it. It answers the library's own outcomes itself: no handler, a payload
// that does not decode, a handler that throws, and an address this schema lacks. The transport hands it only calls it
// admitted, once the handshake told who the peer is.

import { createAsyncTaskPool } from '@dotli/shared';
import { decodeReason, failureReason } from './errors.js';
import { createRecentIds, type Address, type Outcome, type Post, type RunListener } from './parts.js';
import { err, hostFailure, malformedFrame, ok, unsupported, type CallError } from './result.js';
import type { HelloOf, Schema } from './schema.js';
import { encodeMessage, type Header, type MethodMessage, type UnknownAddressMessage } from './wire.js';

/** What a handler knows about the peer that called it. */
export interface CallContext<S extends Schema> {
  /** The peer's origin when the call arrived, or null when it has none. */
  origin: string | null;
  /** The peer's handshake hello. */
  hello: HelloOf<S>;
}

/** What a subscription handler sends on. Both do nothing once the subscription has ended. */
export interface Sink<V, I> {
  /** Sends a value. One the wire cannot carry ends the subscription with `HostFailure`. */
  receive(value: V): void;
  /** Ends the subscription: cleanly with no argument, or with `error`, any variant a relay passes on. */
  interrupt(error?: CallError<I>): void;
}

/** A request or a start, which carries the call's payload. */
type CallMessage = Extract<MethodMessage, { payload: unknown }>;
type StopMessage = Extract<MethodMessage, { leg: 'stop' }>;

export type AnyHandler = (payload: unknown, context: CallContext<Schema>) => Outcome | PromiseLike<Outcome>;
export type AnySubscriptionHandler = (
  start: unknown,
  context: CallContext<Schema>,
  sink: Sink<unknown, unknown>,
) => () => void;

export interface ServingDeps {
  schema: Schema;
  post: Post;
  /** The context of an admitted call. */
  context: () => CallContext<Schema>;
  /** Whether the transport has closed, after which the peer hears no answer. */
  closed: () => boolean;
  /** Reports a message that does not fit what it names. */
  refuse: (cause: Error) => void;
  runListener: RunListener;
  /** Hears that the peer left: its own stop left nothing running, and its calls have settled. Once per departure. */
  onPeerIdle: (() => void) | undefined;
}

export interface Serving {
  /** One handler per method. Returns what unregisters it. */
  handleRequest(address: Address, name: string, handler: AnyHandler): () => void;
  handleSubscription(address: Address, name: string, handler: AnySubscriptionHandler): () => void;
  onRequest(message: CallMessage): void;
  onStart(message: CallMessage): void;
  /** Runs the stop function. Refused when the stop names nothing running and nothing this side ended lately. */
  onStop(message: StopMessage): void;
  /** Answers a call on a schema method whose payload did not decode. Its refusal is already reported. */
  onMalformed(header: Header, cause: unknown): void;
  /** Answers a message for an address this schema lacks on the protocol error address. */
  onUnknownAddress(message: UnknownAddressMessage): void;
  /** Interrupts every running subscription with `HostFailure` carrying `error`, and runs its stop function. */
  close(error: Error): void;
}

interface Running extends Address {
  /** Null until the handler returns it. */
  stop: (() => void) | null;
}

// The peer may stop a subscription until it hears this side's interrupt, so a stop on one ended here lately is a race
// and quiet. A stop on any other subscription that is not running was never started. The ids of this many of the
// latest ends are kept.
const REMEMBERED_ENDS = 1_024;

// Trait and method ids are each a byte, so this key is unique per method.
const keyOf = ({ trait, method }: Address): number => trait * 256 + method;

/** Stores one handler per method, and returns what unregisters it. */
function register<H>(handlers: Map<number, H>, address: Address, name: string, handler: H): () => void {
  const key = keyOf(address);
  if (handlers.has(key)) {
    throw new Error(`${name} already has a handler`);
  }
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) {
      handlers.delete(key);
    }
  };
}

export function createServing(deps: ServingDeps): Serving {
  const { schema, post, context, closed, refuse, runListener, onPeerIdle } = deps;
  const requestHandlers = new Map<number, AnyHandler>();
  const subscriptionHandlers = new Map<number, AnySubscriptionHandler>();
  const running = new Map<number, Running>();
  // Runs the request handlers, so the wait for a peer that left is a wait for every call of its to settle. The pool
  // answers a handler that throws at once like one that rejects.
  const handlers = createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY });
  const lateEnds = createRecentIds(REMEMBERED_ENDS);
  // How many calls the peer has made so far, admitted or not. It only grows, so a wait that read it can tell whether the
  // peer called again since.
  let peerCalls = 0;
  // The count `onPeerIdle` last fired at, so one departure fires it once and the peer's next call arms it again.
  let idleHeardAt: number | null = null;

  /** An outcome as bytes. One the wire cannot carry, such as an undeclared domain error, is the handler's fault. */
  const encodeOutcome = (header: Header & { leg: 'response' | 'interrupt' }, outcome: Outcome): ArrayBuffer => {
    const message = { kind: 'method', ...header } as const;
    try {
      return encodeMessage(schema, { ...message, outcome });
    } catch (error) {
      return encodeMessage(schema, { ...message, outcome: err(hostFailure(failureReason(error))) });
    }
  };

  const answerCall = (header: Header, outcome: Outcome): void => {
    // A handler that settles once the transport closed has no peer left to hear it.
    if (closed()) {
      return;
    }
    const { id, trait, method } = header;
    if (header.leg === 'request') {
      post(encodeOutcome({ id, trait, method, leg: 'response' }, outcome), header);
    } else if (header.leg === 'start') {
      lateEnds.add(id);
      post(encodeOutcome({ id, trait, method, leg: 'interrupt' }, outcome), header);
    }
  };

  const runStop = ({ stop }: Running): void => {
    if (stop !== null) {
      runListener(stop);
    }
  };

  /**
   * Ends a running subscription once: the peer hears `outcome`, then the stop function runs. The interrupt goes first,
   * so a stop function that disposes the transport cannot keep it from the peer.
   */
  const finish = (id: number, entry: Running, outcome: Outcome): void => {
    if (running.get(id) !== entry) {
      return;
    }
    running.delete(id);
    lateEnds.add(id);
    post(encodeOutcome({ id, trait: entry.trait, method: entry.method, leg: 'interrupt' }, outcome), entry);
    runStop(entry);
  };

  /** Tells `onPeerIdle` once the peer's calls have settled, unless it called again meanwhile or the transport closed. */
  const whenPeerIdle = async (seen: number): Promise<void> => {
    await handlers.settle();
    if (closed() || peerCalls !== seen || idleHeardAt === seen || onPeerIdle === undefined) {
      return;
    }
    idleHeardAt = seen;
    runListener(onPeerIdle);
  };

  return {
    handleRequest(address, name, handler) {
      return register(requestHandlers, address, name, handler);
    },

    handleSubscription(address, name, handler) {
      return register(subscriptionHandlers, address, name, handler);
    },

    onRequest(message) {
      const callContext = context();
      // A peer that calls is still here, whatever it stopped before.
      peerCalls += 1;
      const handler = requestHandlers.get(keyOf(message));
      if (handler === undefined) {
        answerCall(message, err(unsupported()));
        return;
      }
      void handlers
        .call(() => handler(message.payload, callContext))
        .then(
          outcome => {
            answerCall(message, outcome);
          },
          (error: unknown) => {
            answerCall(message, err(hostFailure(failureReason(error))));
          },
        );
    },

    onStart(message) {
      const { id } = message;
      const callContext = context();
      peerCalls += 1;
      if (running.has(id)) {
        refuse(new Error(`A start names subscription ${String(id)}, which is already running`));
        return;
      }
      const handler = subscriptionHandlers.get(keyOf(message));
      if (handler === undefined) {
        answerCall(message, err(unsupported()));
        return;
      }
      const entry: Running = { trait: message.trait, method: message.method, stop: null };
      running.set(id, entry);
      const sink: Sink<unknown, unknown> = {
        receive(value) {
          if (running.get(id) !== entry) {
            return;
          }
          let data: ArrayBuffer;
          try {
            data = encodeMessage(schema, { ...message, leg: 'receive', payload: value });
          } catch (error) {
            finish(id, entry, err(hostFailure(failureReason(error))));
            return;
          }
          post(data, entry);
        },
        interrupt(error) {
          finish(id, entry, error === undefined ? ok() : err(error));
        },
      };
      let stop: () => void;
      try {
        stop = handler(message.payload, callContext, sink);
      } catch (error) {
        finish(id, entry, err(hostFailure(failureReason(error))));
        return;
      }
      if (running.get(id) === entry) {
        entry.stop = stop;
      } else {
        // Ended while the handler ran, before it could say how to stop.
        runListener(stop);
      }
    },

    onStop(message) {
      const { id } = message;
      const entry = running.get(id);
      if (entry === undefined) {
        if (!lateEnds.has(id)) {
          refuse(new Error(`A stop names subscription ${String(id)}, which is not running`));
          return;
        }
        // The peer stopped it before it heard this side's interrupt. A second stop for it is no race.
        lateEnds.delete(id);
      } else {
        if (entry.trait !== message.trait || entry.method !== message.method) {
          refuse(new Error(`The stop for subscription ${String(id)} names another method than the subscription`));
          return;
        }
        running.delete(id);
        runStop(entry);
      }
      // Only the peer stops, so its own stop leaves nothing it opened running, even when this side ended that
      // subscription before the stop arrived.
      if (running.size === 0) {
        void whenPeerIdle(peerCalls);
      }
    },

    onMalformed(header, cause) {
      // A call whose payload did not decode still tells that the peer is here.
      peerCalls += 1;
      answerCall(header, err(malformedFrame(decodeReason(cause))));
    },

    onUnknownAddress(message) {
      if (message.leg === 'request' || message.leg === 'start') {
        peerCalls += 1;
      }
      const data = encodeMessage(schema, {
        kind: 'protocolError',
        id: message.id,
        unsupportedMessage: message.unknownAddress,
      });
      post(data);
    },

    close(error) {
      const outcome = err(hostFailure(failureReason(error)));
      for (const [id, entry] of [...running]) {
        finish(id, entry, outcome);
      }
    },
  };
}
