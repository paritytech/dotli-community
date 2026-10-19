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
  TransportMalformedResponseError,
  TransportUnsupportedProtocolVersionError,
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
  type TransportVersions,
} from './errors.js';
import type { Provider } from './provider.js';
import { createRecentIds } from './recent-ids.js';
import {
  SUBSCRIPTION_STOP,
  sameMethod,
  type Address,
  type AnyMethod,
  type Request,
  type Schema,
  type Subscription,
  type Sections,
} from './schema.js';
import {
  WIRE_VERSION,
  decode,
  encodeCall,
  frame,
  whole,
  type Call,
  type Frame,
  type HandshakeOffer,
  type HandshakeResponse,
} from './wire.js';

/** What a subscriber hears: each value, then one end, unless it stops first. */
export interface SubscriptionListeners<V, I> {
  receive(value: V): void;
  /** The peer's own end, the method's own interrupt reason as it is. */
  interrupt(reason: I): void;
  /** A failure of the library's: one the peer answered with, or `Cancelled` or `MalformedFrame` raised on this side. */
  fail(failure: Failure): void;
  /** The end raised on this side with an error: the transport closed, a failed post among the ways it does. */
  close(error: Error): void;
}

/** What a handler knows about the peer that called it. */
export interface CallContext<H> {
  /** The peer's handshake hello. */
  hello: H;
}

/** What a subscription handler sends on. Both do nothing once the subscription has ended. */
export interface Sink<V, I> {
  /** Sends a value. One the wire cannot carry ends the subscription with `HostFailure`. */
  send(value: V): void;
  /** Ends the subscription with `reason`, the method's own interrupt type, which the subscriber hears as it is. */
  interrupt(reason: I): void;
}

/** Serves one request method. It answers with a `Result`, and a throw or rejection answers `HostFailure`. */
export type RequestHandler<P, R, E, H> = (
  payload: P,
  context: CallContext<H>,
) => ResultPayload<R, CallError<E>> | PromiseLike<ResultPayload<R, CallError<E>>>;

/**
 * Serves one subscription method. It starts the subscription, sends on the sink, and returns what stops it, which runs
 * once on the peer's stop, an interrupt, a start that reuses its id, or a close. A throw on start interrupts with
 * `HostFailure`.
 */
export type SubscriptionHandler<S, V, I, H> = (start: S, context: CallContext<H>, sink: Sink<V, I>) => () => void;

export interface TransportOptions<H> {
  /** Which side opens the handshake. The other accepts it. */
  handshake: 'offer' | 'respond';
  /** This side's handshake value, encoded once. One its codec refuses throws at creation. */
  hello: H;
  /** How often the opener posts a fresh handshake offer until it is answered. */
  retryMs?: number | undefined;
  /**
   * How long the opener waits for an answer, on the running clock. Null sets no deadline, for an owner that bounds the
   * wait itself and disposes the transport when it gives up, so the wait has one deadline only.
   */
  timeoutMs?: number | null | undefined;
  timers?: Timers | undefined;
  /** Hears what the transport cannot handle itself. With none, each issue is logged as an error. */
  onIssue?: ((issue: TransportIssue) => void) | undefined;
}

export interface RequestOptions {
  /** Gives up on the call: it resolves `Cancelled` and a late answer is ignored. The peer is not told. */
  signal?: AbortSignal;
}

export interface SubscribeOptions {
  /** Gives up on the subscription: the peer is told to stop and `fail` hears `Cancelled`, once. */
  signal?: AbortSignal;
}

/** Calls and serves the methods of one schema, whose hello is `H`. A method is passed as the schema holds it. */
export interface Transport<H> {
  /**
   * Starts the handshake on the opener, for a side that starts it before its first call. Does nothing on the accepter,
   * which waits for the opener.
   */
  connect(): void;
  /**
   * Resolves once the handshake succeeds, and rejects with the closing error once the transport closes. Starts the
   * handshake on the opener, as `connect` does.
   */
  whenConnected(): Promise<void>;
  /**
   * Calls the peer, and starts the handshake on the opener, as `connect` does. Resolves to its `Result`, or to
   * `Cancelled` once the signal aborts. Calls made before the handshake wait and go out in call order once it succeeds.
   * Rejects with the error the transport closed with, a post the provider throws on among them, with
   * `TransportMalformedResponseError` when the answer does not decode, or when the payload does not encode.
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
   * Subscribes to the peer, and starts the handshake on the opener, as `connect` does. `receive` hears each value, and
   * `interrupt`, `fail` or `close` the one end. Subscriptions made before the handshake wait and go out in call order
   * with the requests. Returns `unsubscribe`, which stops it at the peer and calls no listener. Throws when the start
   * does not encode.
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
   * Serves each of `methods` by forwarding the peer's calls to `upstream` as their message bytes, and the answers back.
   * A forwarded call waits for `upstream`'s handshake like its own calls, and is answered `HostFailure` with the
   * closing error when `upstream` closes under it. Returns what stops forwarding them, which leaves the open calls to
   * run to their end. Throws for a method `upstream` does not place at the same ids, for an `upstream` this library did
   * not build, and for a method that already has a handler.
   */
  forward(methods: readonly AnyMethod[], upstream: Transport<unknown>): () => void;
  /**
   * Closes this side, and posts nothing. Every subscription it serves stops, every one it made hears `close(reason)`,
   * every pending and later request rejects with `reason`, and the provider is disposed.
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
  /** Ends it with nothing sent, and runs its stop function. */
  drop(): void;
}

/** What a call opened for a forwarder hears from the peer it went to. */
interface Heard {
  /** A message on the call, as its bytes. */
  message(bytes: Uint8Array): void;
  /** The failure the peer answered the call with, which ends it. */
  fail(error: Failure): void;
  /** The transport closed with `error`, which ends the call. */
  close(error: Error): void;
}

/** A call opened for a forwarder. */
interface Forwarded {
  /** Posts a further message on the call once it went out, and nothing while it waits for the handshake. */
  send(bytes: Uint8Array): void;
  /** Ends the call with nothing posted, so a late message on it is dropped and one still waiting never goes out. */
  forget(): void;
}

/** What a forwarder reaches of the transport it forwards to. */
interface Upstream {
  /** Where the upstream's schema places `method`. Throws for a method it lacks. */
  addressOf(method: AnyMethod): Address;
  /** Opens a call of the method at `address` that carries `message` as it is. */
  open(address: Address, message: Uint8Array, heard: Heard): Forwarded;
}

// Each transport this library built, so `forward` reaches another's calls with no public raw frame API.
const upstreams = new WeakMap<Transport<unknown>, Upstream>();

/** A frame that carries `message` on call `id` of the method at `address`, as the bytes it is. */
const carrying = (address: Address, id: number, message: Uint8Array): Uint8Array =>
  frame.enc({
    id,
    body: { tag: 'call', value: { sectionId: address.sectionId, methodId: address.methodId, message } },
  });

const DEFAULT_RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
// What a call of the peer's that came before the handshake was over is answered with.
const HANDSHAKE_NOT_OVER = 'The handshake is not over';
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

  // Encoded once, so neither side encodes it per handshake, and a hello its codec refuses throws here.
  const ourHello = schema.hello.enc(options.hello);
  let phase: Phase<H> = { name: 'connecting' };
  let disposed = false;
  // Aborted once the handshake is settled or the transport closed, which stops the opener's attempts.
  const stopAttempts = new AbortController();
  const opens = options.handshake === 'offer';
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
   * Posts bytes, of the call at `address` when they belong to one. A closed transport posts nothing. A post the provider
   * throws on is reported, then closes the transport with the provider's error, as truapi's client does, so every call
   * hears it. Either way it returns why nothing went out.
   */
  const post = (data: Uint8Array, address?: Address): ResultPayload<undefined, Error> => {
    if (phase.name === 'closed') {
      return err(phase.error);
    }
    try {
      provider.postMessage(data);
      return ok();
    } catch (thrown) {
      const error = toError(thrown);
      const call = address === undefined ? undefined : { section: address.section, method: address.method };
      report({ kind: 'post_failed', error, call });
      close(error);
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
      startHandshake();
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
          const message = decode(method.wholeMessage, bytes);
          if (!message.success) {
            refuse('malformed', message.value);
            abandon(new TransportMalformedResponseError(address, message.value));
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
        // A post the provider throws on closes the transport, which rejects this call with why.
        post(data.value, address);
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
    const interrupt = (reason: I): void => {
      finish(false, () => {
        listeners.interrupt(reason);
      });
    };
    const fail = (failure: Failure, tellPeer: boolean): void => {
      finish(tellPeer, () => {
        listeners.fail(failure);
      });
    };
    // A closed transport posts nothing, so the peer is not told.
    const close = (error: Error): void => {
      finish(false, () => {
        listeners.close(error);
      });
    };
    const onAbort = (): void => {
      fail(cancelled(), true);
    };

    const call: OutCall = {
      address,
      hear(bytes) {
        const message = decode(method.wholeMessage, bytes);
        if (!message.success) {
          // What was lost may be a value, which leaves the subscriber behind the peer, so the subscription ends and the
          // peer is told to stop. A stop after the peer's own end is a race it drops. Nothing follows an interrupt, so
          // the peer that sent one hears no stop. A message whose leg cannot be read counts as a value.
          refuse('malformed', message.value);
          const leg = decode(method.leg, bytes);
          fail(malformedFrame(message.value), !leg.success || leg.value.tag !== 'interrupt');
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
            interrupt(sent.value);
            return;
          case 'start':
          case 'stop':
            refuse('invalid', new Error(`A ${sent.tag} names subscription ${String(id)}, which this side made`));
        }
      },
      fail(error) {
        fail(error, false);
      },
      close,
    };

    // Encoded at once, so a start the wire refuses throws to the caller. It is posted once, so the buffer stays whole.
    const data = encodeCall(method, address, id, { tag: 'start', value: start });
    if (!data.success) {
      throw data.value;
    }
    startHandshake();
    const unsubscribe = (): void => {
      finish(true, null);
    };
    if (signal?.aborted === true) {
      // Heard on a microtask, so no listener runs before the caller holds its `unsubscribe`.
      queueMicrotask(onAbort);
      return unsubscribe;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    place(() => {
      if (state !== 'queued') {
        return;
      }
      out.set(id, call);
      // A post the provider throws on closes the transport, which closes this subscription with why.
      if (!post(data.value, address).success) {
        return;
      }
      // Open only once the start went out, so a stop from the issue hook of a failed post sees nothing the peer could
      // stop. A post that succeeds hears nothing before it returns.
      state = 'open';
    }, close);
    return unsubscribe;
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

  /**
   * Opens a call for a transport that forwards its peer's calls here. It starts the handshake and waits for it with the
   * other calls, as `subscribe` does, and its messages cross as the bytes they are.
   */
  const open = (address: Address, message: Uint8Array, heard: Heard): Forwarded => {
    let state: 'queued' | 'open' | 'ended' = 'queued';
    const id = nextId();
    const end = (): void => {
      state = 'ended';
      if (out.delete(id)) {
        ended.add(id);
      }
    };
    const call: OutCall = {
      address,
      hear(bytes) {
        heard.message(bytes);
      },
      fail(error) {
        end();
        heard.fail(error);
      },
      close(error) {
        end();
        heard.close(error);
      },
    };
    startHandshake();
    place(
      () => {
        if (state !== 'queued') {
          return;
        }
        out.set(id, call);
        // A post the provider throws on closes the transport, which ends this call with why.
        if (post(carrying(address, id, message), address).success) {
          state = 'open';
        }
      },
      error => {
        if (state === 'queued') {
          state = 'ended';
          heard.close(error);
        }
      },
    );
    return {
      send(bytes) {
        if (state === 'open') {
          post(carrying(address, id, bytes), address);
        }
      },
      forget: end,
    };
  };

  // The calls this side serves. Each method's handler decodes the peer's messages with the method's own codec, answers a
  // request with its `Result` and streams a subscription until one side ends it. The library's own outcomes, no handler, a
  // message that does not decode and a handler that throws, go back as a failure frame. Only calls the transport
  // admitted reach this side, once the handshake told who the peer is.

  const handlers = new Map<AnyMethod, Served<H>>();
  // The peer's requests whose handlers have not settled, by id, with what drops each. A close drops them, so none is
  // answered.
  const inFlight = new Map<number, () => void>();
  const running = new Map<number, Running>();

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
    post(frame.enc({ id, body: { tag: 'failed', value: error } }), address);
  };

  /** Answers a call whose message does not decode. */
  const malformed = (id: number, cause: Error, address: Address): void => {
    refuse('malformed', cause);
    postFailed(id, malformedFrame(cause), address);
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

  /**
   * Refuses a request whose id is still in flight. As truapi does, that is the peer's mistake, and the one in flight
   * keeps it.
   */
  const reusesInFlight = (id: number): boolean => {
    if (!inFlight.has(id)) {
      return false;
    }
    refuse('invalid', new Error(`A request reuses call ${String(id)}, which is still in flight`));
    return true;
  };

  function handleRequest<P, R, E>(method: Request<P, R, E>, handler: RequestHandler<P, R, E, H>): () => void {
    const address = schema.addressOf(method);
    return register(method, address, (id, bytes, context) => {
      if (reusesInFlight(id)) {
        return;
      }
      const message = decode(method.wholeMessage, bytes);
      if (!message.success) {
        malformed(id, message.value, address);
        return;
      }
      if (message.value.tag !== 'request') {
        refuse('invalid', new Error(`A response names call ${String(id)}, which the peer made`));
        return;
      }
      const payload = message.value.value;
      // A handler's late answer finds its id gone, so dropping it needs nothing more.
      inFlight.set(id, () => undefined);
      // Run in the turn the call arrives, and a handler that throws answers like one that rejects.
      void new Promise<ResultPayload<R, CallError<E>>>(resolve => {
        resolve(handler(payload, context));
      }).then(
        outcome => {
          // A closed transport dropped the call, and answers nothing.
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
       * Ends the subscription once: `send`, if any, tells the peer, then the stop function runs. The peer hears it first,
       * so a stop function that disposes the transport cannot keep it from the peer.
       */
      const finish = (send?: () => void): void => {
        if (running.get(id) !== entry) {
          return;
        }
        running.delete(id);
        send?.();
        runStop();
      };
      /** Ends it with a failure the peer hears. */
      const failWith = (error: Failure): void => {
        finish(() => {
          postFailed(id, error, address);
        });
      };

      const entry: Running = {
        address,
        hear(bytes) {
          const message = decode(method.wholeMessage, bytes);
          if (!message.success) {
            refuse('malformed', message.value);
            return;
          }
          if (message.value.tag !== 'stop') {
            refuse('invalid', new Error(`A ${message.value.tag} names subscription ${String(id)}, which is running`));
            return;
          }
          finish();
        },
        drop: () => {
          finish();
        },
      };
      running.set(id, entry);

      const sink: Sink<V, I> = {
        send(value) {
          if (running.get(id) !== entry) {
            return;
          }
          const data = encodeCall(method, address, id, { tag: 'receive', value });
          if (!data.success) {
            failWith(hostFailure(data.value));
            return;
          }
          post(data.value, address);
        },
        interrupt(reason) {
          finish(() => {
            reply(method, address, id, { tag: 'interrupt', value: reason });
          });
        },
      };
      let stopIt: () => void;
      try {
        stopIt = handler(startValue, context, sink);
      } catch (error) {
        failWith(hostFailure(toError(error)));
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
      const message = decode(method.wholeMessage, bytes);
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

  // The calls this side forwards. Each goes on to the upstream as a call of its own, numbered there, and every message
  // crosses as the bytes it is, so only the far ends decode a payload. Only the leg of a message is read, to follow the
  // call's life.

  /** Forwards a peer's request, and posts the upstream's answer back on its id. */
  const forwardRequest = (
    upstream: Upstream,
    method: AnyMethod,
    address: Address,
    id: number,
    request: Uint8Array,
  ): void => {
    if (reusesInFlight(id)) {
      return;
    }
    const call = upstream.open(address, request, {
      message(answer) {
        const leg = decode(method.leg, answer);
        // An answer whose leg cannot be read goes back, so the peer refuses it as one it cannot decode.
        if (leg.success && leg.value.tag !== 'response') {
          refuse('invalid', new Error(`A ${leg.value.tag} answers forwarded call ${String(id)}`));
          return;
        }
        call.forget();
        if (inFlight.delete(id)) {
          post(carrying(address, id, answer), address);
        }
      },
      fail(error) {
        if (inFlight.delete(id)) {
          postFailed(id, error, address);
        }
      },
      close(error) {
        if (inFlight.delete(id)) {
          postFailed(id, hostFailure(error), address);
        }
      },
    });
    inFlight.set(id, () => {
      call.forget();
    });
  };

  /** Forwards a peer's subscription, and posts what the upstream sends back on its id until either side ends it. */
  const forwardSubscription = (
    upstream: Upstream,
    method: AnyMethod,
    address: Address,
    id: number,
    start: Uint8Array,
  ): void => {
    /** Ends it here once. Returns whether it was still running. */
    const finish = (): boolean => {
      if (running.get(id) !== entry) {
        return false;
      }
      running.delete(id);
      return true;
    };
    const stopWith = (stop: Uint8Array): void => {
      if (finish()) {
        call.send(stop);
        call.forget();
      }
    };
    const entry: Running = {
      address,
      hear(message) {
        const leg = decode(method.leg, message);
        if (!leg.success) {
          refuse('malformed', leg.value);
        } else if (leg.value.tag === 'stop') {
          stopWith(message);
        } else {
          refuse('invalid', new Error(`A ${leg.value.tag} names subscription ${String(id)}, which is running`));
        }
      },
      // The upstream is still open, so it stops what it holds there, as a subscriber stops its own.
      drop: () => {
        stopWith(SUBSCRIPTION_STOP);
      },
    };
    const call = upstream.open(address, start, {
      message(sent) {
        const leg = decode(method.leg, sent);
        // A message whose leg cannot be read counts as a value, as a subscriber counts it.
        const tag = leg.success ? leg.value.tag : 'receive';
        if (tag === 'start' || tag === 'stop') {
          refuse('invalid', new Error(`A ${tag} names forwarded subscription ${String(id)}, which this side made`));
          return;
        }
        if (tag === 'interrupt') {
          finish();
          call.forget();
        }
        post(carrying(address, id, sent), address);
      },
      fail(error) {
        if (finish()) {
          postFailed(id, error, address);
        }
      },
      close(error) {
        if (finish()) {
          postFailed(id, hostFailure(error), address);
        }
      },
    });
    running.set(id, entry);
  };

  /** Serves `method` by forwarding each call the peer opens to `upstream`, a request or a subscription by its leg. */
  const forwarding =
    (upstream: Upstream, method: AnyMethod, address: Address): Served<H> =>
    (id, message) => {
      const leg = decode(method.leg, message);
      if (!leg.success) {
        malformed(id, leg.value, address);
        return;
      }
      switch (leg.value.tag) {
        case 'request':
          forwardRequest(upstream, method, address, id, message);
          return;
        case 'start':
          forwardSubscription(upstream, method, address, id, message);
          return;
        default:
          refuse('invalid', new Error(`A ${leg.value.tag} names call ${String(id)}, which is not open`));
      }
    };

  function forward(methods: readonly AnyMethod[], to: Transport<unknown>): () => void {
    const upstream = upstreams.get(to);
    if (upstream === undefined) {
      throw new Error('The upstream transport was not built by this library');
    }
    const placed = methods.map(method => {
      const address = schema.addressOf(method);
      if (!sameMethod(upstream.addressOf(method), address)) {
        throw new Error(`${address.section}.${address.method} sits elsewhere in the upstream`);
      }
      return { method, address };
    });
    const unregisters: (() => void)[] = [];
    const unregisterAll = (): void => {
      for (const unregister of unregisters) {
        unregister();
      }
    };
    // A method refused partway leaves none of the others forwarded.
    try {
      for (const { method, address } of placed) {
        unregisters.push(register(method, address, forwarding(upstream, method, address)));
      }
    } catch (error) {
      unregisterAll();
      throw error;
    }
    return unregisterAll;
  }

  /** The leg a message of the peer's reads as, or undefined when its method is not this schema's or it reads as none. */
  const legOf = (call: Call<Uint8Array>): string | undefined => {
    const method = schema.methodAt(call.sectionId, call.methodId);
    const leg = method === undefined ? undefined : decode(method.leg, call.message);
    return leg?.success === true ? leg.value.tag : undefined;
  };

  /** Hands a message of the peer's call `id` to what serves it. */
  const hearPeer = (id: number, call: Call<Uint8Array>, context: CallContext<H>): void => {
    const entry = running.get(id);
    const leg = legOf(call);
    if (entry !== undefined && leg === 'start') {
      // A start on a running id subscribes anew, as truapi does: the running one stops with nothing sent.
      entry.drop();
    } else if (entry !== undefined) {
      if (!sameMethod(entry.address, call)) {
        refuse('invalid', new Error(`A message for subscription ${String(id)} names another method`));
        return;
      }
      entry.hear(call.message);
      return;
    } else if (leg === 'stop') {
      // A stop for a subscription that is not running stops nothing, such as one that crossed this side's end.
      return;
    }
    const method = schema.methodAt(call.sectionId, call.methodId);
    const served = method === undefined ? undefined : handlers.get(method);
    if (served === undefined) {
      postFailed(id, unsupported());
      return;
    }
    served(id, call.message, context);
  };

  /**
   * Answers a call of the peer's that came before the handshake was over, whose handler never runs, with `HostFailure`.
   * A message that reads as no request or start opens no call, so it is only refused.
   */
  const answerEarly = (id: number, call: Call<Uint8Array>): void => {
    refuse('invalid', new Error('A call came before the handshake'));
    const leg = legOf(call);
    if (leg === undefined || leg === 'request' || leg === 'start') {
      postFailed(id, hostFailure(HANDSHAKE_NOT_OVER));
    }
  };

  /**
   * Closes this side, and posts nothing, as truapi's runtime does on dispose. The peer's calls in flight are dropped and
   * each subscription served stops. Each call this side made that still waits rejects, and each subscription closes.
   * Calls still waiting for the handshake find the error as they leave.
   */
  function close(error: Error): void {
    if (phase.name === 'closed') {
      return;
    }
    phase = { name: 'closed', error };
    stopAttempts.abort(error);
    handshakeOver.resolve(undefined);
    const dropped = [...inFlight.values()];
    inFlight.clear();
    for (const drop of dropped) {
      drop();
    }
    for (const entry of [...running.values()]) {
      entry.drop();
    }
    for (const outCall of [...out.values()]) {
      outCall.close(error);
    }
  }

  // One side opens the handshake and the other accepts it. The opener posts a fresh attempt every `retryMs` until an
  // answer comes or `timeoutMs` passes, since the accepter may not be listening yet. Each side settles the handshake
  // once, with whether the peer is there and what its hello is. Both the library's wire version and the schema's must
  // match.

  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const timers = options.timers ?? realTimers;
  const attempts = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: options.retryMs ?? DEFAULT_RETRY_MS,
    retryIf: error => error instanceof HandshakeUnansweredError,
    timers,
  });
  let started = false;
  // Built once, so no handshake composes a decoder.
  const wholeHello = whole(schema.hello);
  const ours: TransportVersions = { wire: WIRE_VERSION, schema: schema.version };
  const sameVersions = (theirs: TransportVersions): boolean =>
    theirs.wire === ours.wire && theirs.schema === ours.schema;

  /**
   * Settles the handshake once, on either side, with the peer's hello or why it failed. An answer settles the opener in
   * the turn it arrives, so a call the accepter makes right after its answer finds this side open.
   */
  const settleHandshake = (outcome: ResultPayload<H, Error>): void => {
    if (phase.name !== 'connecting') {
      return;
    }
    if (outcome.success) {
      phase = { name: 'connected', peerHello: outcome.value };
      stopAttempts.abort();
      handshakeOver.resolve(undefined);
    } else {
      close(outcome.value);
    }
  };

  // An attempt is no call, so it takes no call id, and the accepter's answer echoes it. The frame is built anew each
  // time, since the provider may transfer its buffer.
  const attempt = (): never => {
    const offer = { versions: ours, hello: ourHello };
    const posted = post(frame.enc({ id: 0, body: { tag: 'handshakeOffer', value: offer } }));
    if (!posted.success) {
      throw posted.value;
    }
    throw new HandshakeUnansweredError('The handshake is not answered yet');
  };

  /** Starts the opener's handshake once, unless the transport closed. Does nothing on the accepter. */
  function startHandshake(): void {
    if (!opens || started || stopAttempts.signal.aborted) {
      return;
    }
    started = true;
    // An attempt fails until an answer comes, so the pool posts a fresh one every `retryMs` until it is stopped. It
    // settles only when stopped, or when an attempt cannot be posted.
    const retrying = attempts.call<never>(attempt, { signal: stopAttempts.signal });
    const answered =
      timeoutMs === null
        ? retrying
        : withTimeout(
            retrying,
            timeoutMs,
            () => new TransportHandshakeTimeoutError(`No handshake answer within ${String(timeoutMs)} ms`),
            timers,
          );
    answered.catch((error: unknown) => {
      settleHandshake(err(toError(error)));
    });
  }

  const heardResponse = (response: HandshakeResponse): void => {
    if (!started) {
      refuse('invalid', new Error('A handshake answer came before this side opened the handshake'));
      return;
    }
    // Only the first answer counts. The rest answer attempts already in flight.
    if (!response.success) {
      settleHandshake(err(new TransportUnsupportedProtocolVersionError(ours, response.value)));
      return;
    }
    const hello = decode(wholeHello, response.value);
    if (!hello.success) {
      refuse('malformed', hello.value);
      return;
    }
    settleHandshake(hello);
  };

  // The accepter's answer to the first attempt, which every later attempt hears again.
  let first: HandshakeResponse | undefined;

  const heardOffer = (id: number, offer: HandshakeOffer): void => {
    const same = sameVersions(offer.versions);
    const peerHello = same ? decode(wholeHello, offer.hello) : undefined;
    if (peerHello?.success === false) {
      refuse('malformed', peerHello.value);
      return;
    }
    const deciding = first === undefined;
    first ??= same ? ok(ourHello) : err(ours);
    // A post the provider throws on closes this side, so an answer that decides is always one the opener can hear.
    const posted = post(frame.enc({ id, body: { tag: 'handshakeResponse', value: first } }));
    if (posted.success && deciding) {
      settleHandshake(peerHello ?? err(new TransportUnsupportedProtocolVersionError(ours, offer.versions)));
    }
  };

  const receive = (data: Uint8Array): void => {
    const received = decode(frame.dec, data);
    if (!received.success) {
      refuse('malformed', received.value);
      return;
    }
    const { id, body } = received.value;
    switch (body.tag) {
      case 'handshakeOffer':
        if (opens) {
          refuse('invalid', new Error('A handshake offer reached the side that opens the handshake'));
        } else if (phase.name === 'closed') {
          refuse(
            'invalid',
            new Error(`A handshake offer came after the transport closed, ${failureReason(phase.error)}`),
          );
        } else {
          heardOffer(id, body.value);
        }
        return;
      case 'handshakeResponse':
        if (opens) {
          heardResponse(body.value);
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
          hearPeer(id, body.value, { hello: phase.peerHello });
        } else if (phase.name === 'connecting') {
          // The peer acts on this side only once the handshake told who it is.
          answerEarly(id, body.value);
        } else {
          refuse('invalid', new Error(`A call came after the transport closed, ${failureReason(phase.error)}`));
        }
    }
  };
  // Nothing thrown while a frame is handled reaches the provider, whose other listeners must still hear it.
  const onData = (data: Uint8Array): void => {
    try {
      receive(data);
    } catch (error) {
      refuse('invalid', new Error('The message could not be handled', { cause: error }));
    }
  };
  // Providers do not buffer, so the listener is bound before anything can arrive.
  const unsubscribeProvider = provider.subscribe(onData);
  // With no peer here the transport is closed from the start, so no handshake is posted.
  if (!provider.isCorrectEnvironment()) {
    close(new Error('Environment is not correct'));
  }

  const transport: Transport<H> = {
    connect: startHandshake,

    async whenConnected() {
      startHandshake();
      await handshakeOver.promise;
      if (phase.name === 'closed') {
        throw phase.error;
      }
    },

    request,
    handleRequest,
    subscribe,
    handleSubscription,
    forward,

    dispose(reason) {
      if (disposed) {
        return;
      }
      disposed = true;
      close(reason);
      unsubscribeProvider();
      provider.dispose();
    },
  };
  upstreams.set(transport, { addressOf: schema.addressOf, open });
  return transport;
}
