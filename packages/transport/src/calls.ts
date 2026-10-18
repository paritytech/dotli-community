// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side makes: requests and subscriptions. Each waits in a task pool until the handshake is over, then
// goes out, and what comes back is matched to it by id. Every post encodes a fresh buffer, since a transferred one is
// detached.

import { createAsyncTaskPool, toError } from '@dotli/shared';
import { decodeReason } from './errors.js';
import { createRecentIds, type Address, type Outcome, type Post, type RunListener } from './parts.js';
import { cancelled, err, malformedFrame, unsupported, type CallError, type Result } from './result.js';
import type { Schema } from './schema.js';
import { encodeMessage, type Header, type MethodMessage, type ProtocolErrorMessage } from './wire.js';

/** What a subscriber hears: each value, then one end. */
export interface SubscriptionListeners<V, I> {
  receive(value: V): void;
  /** The peer's end, or `Cancelled` or `MalformedFrame` raised on this side. */
  interrupt(outcome: Result<void, CallError<I>>): void;
}

/** A subscription this side made. */
export interface SubscriptionHandle {
  /** Ends the subscription and tells the peer. No listener is called. */
  stop(): void;
  /**
   * Hears the one end raised on this side with an error: the transport closed while the subscription was queued or
   * open, or its start could not be posted. Runs once, and at once if that has already happened. It never runs once the
   * subscription was stopped or interrupted.
   */
  onClose(listener: (error: Error) => void): void;
}

export interface CallsDeps {
  schema: Schema;
  nextId: () => number;
  post: Post;
  /** Settles once the handshake succeeds or fails, or the transport closes. */
  handshakeOver: Promise<void>;
  /** The error the transport closed with, or null while it is open. */
  closedBy: () => Error | null;
  /** Reports a message that does not fit the call it names. */
  refuse: (cause: Error) => void;
  runListener: RunListener;
}

/** A message that carries a `Result`: a response or an interrupt. */
type OutcomeMessage = Extract<MethodMessage, { outcome: unknown }>;
/** A message that carries a payload, of which this side hears only receives. */
type PayloadMessage = Extract<MethodMessage, { payload: unknown }>;

export interface Calls {
  /** Resolves to the peer's outcome or `Cancelled`. Rejects with the closing error, or when the call cannot go out. */
  request(address: Address, payload: unknown, signal: AbortSignal | undefined): Promise<Outcome>;
  /** Opens a subscription. Throws when the start does not encode. */
  subscribe(
    address: Address,
    start: unknown,
    listeners: SubscriptionListeners<unknown, unknown>,
    signal: AbortSignal | undefined,
  ): SubscriptionHandle;
  onResponse(message: OutcomeMessage): void;
  onReceive(message: PayloadMessage): void;
  onInterrupt(message: OutcomeMessage): void;
  /** Ends the call an answer, value or end that did not decode names, as `MalformedFrame` with why. */
  onUndecodable(header: Header, cause: unknown): void;
  onProtocolError(message: ProtocolErrorMessage): void;
  /**
   * Rejects every call that went out and is still waiting with `error`, and closes every subscription with it, telling
   * the peer to stop each open one. Calls still queued find the error as they leave.
   */
  close(error: Error): void;
}

interface PendingRequest extends Address {
  id: number;
  /** Settles the call once. Later outcomes change nothing. */
  settle: (outcome: Outcome | Error) => void;
}

type SubscriptionState = { name: 'queued' | 'open' | 'ended' } | { name: 'closed'; error: Error };

interface Subscription extends Address {
  id: number;
  state: SubscriptionState;
  listeners: SubscriptionListeners<unknown, unknown>;
  closeListeners: ((error: Error) => void)[];
  /** Aborted once the subscription leaves, so one still queued leaves the pool and never goes out. */
  over: AbortController;
  /** Stops listening to the caller's signal. */
  detach: () => void;
}

// The peer may send on a subscription until it hears this side's stop, so a message on one stopped lately is a race and
// dropped quietly. A message on any other subscription that is not open is the peer's fault. The ids of this many of
// the latest stops are kept.
const REMEMBERED_STOPS = 1_024;

export function createCalls(deps: CallsDeps): Calls {
  const { schema, post, handshakeOver, closedBy, refuse, runListener } = deps;
  const waiting = new Map<number, PendingRequest>();
  // Queued and open subscriptions. Messages from the peer reach only the open ones.
  const subscriptions = new Map<number, Subscription>();
  const lateStops = createRecentIds(REMEMBERED_STOPS);
  // Every call waits here for the handshake to be over. It is unbounded, so calls run side by side once it is. Each call
  // is posted one step after it was made or after the handshake ended, whichever is later, so calls go out in call order
  // across the handshake, and a call made while the queue flushes goes out behind it.
  const queue = createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY });

  /** Runs `send` once the handshake is over, unless the call settled meanwhile, or fails with why it cannot go out. */
  const place = (over: AbortSignal, send: () => void, fail: (error: Error) => void): void => {
    queue
      .call(
        async () => {
          await handshakeOver;
          // The queue has already rejected a call settled while it waited, and whatever settled it is its outcome.
          if (over.aborted) {
            return;
          }
          const closedNow = closedBy();
          if (closedNow !== null) {
            throw closedNow;
          }
          send();
        },
        { signal: over },
      )
      .catch((error: unknown) => {
        fail(toError(error));
      });
  };

  const send = (call: PendingRequest, payload: unknown): void => {
    let data: ArrayBuffer;
    try {
      const { id, trait, method } = call;
      data = encodeMessage(schema, { kind: 'method', leg: 'request', id, trait, method, payload });
    } catch (error) {
      call.settle(toError(error));
      return;
    }
    waiting.set(call.id, call);
    const posted = post(data, call);
    if (!posted.ok) {
      call.settle(new Error('The request could not be posted', { cause: posted.error }));
    }
  };

  /** The call waiting under the answer's id, or undefined for a late answer to a call that gave up. */
  const answered = (id: number, address: Address): PendingRequest | undefined => {
    const call = waiting.get(id);
    if (call !== undefined && (call.trait !== address.trait || call.method !== address.method)) {
      refuse(new Error(`The answer to call ${String(id)} names another method than the call`));
      return undefined;
    }
    return call;
  };

  /** Takes a queued or open subscription out as `next`. Returns what it was, or null when it had already left. */
  const leave = (subscription: Subscription, next: SubscriptionState): 'queued' | 'open' | null => {
    const was = subscription.state.name;
    if (was !== 'queued' && was !== 'open') {
      return null;
    }
    subscription.state = next;
    subscription.over.abort();
    subscription.detach();
    if (subscriptions.get(subscription.id) === subscription) {
      subscriptions.delete(subscription.id);
    }
    return was;
  };

  const postStop = ({ id, trait, method }: Subscription): void => {
    lateStops.add(id);
    post(encodeMessage(schema, { kind: 'method', leg: 'stop', id, trait, method }), { trait, method });
  };

  /**
   * Ends a subscription once. `outcome` is what its listener hears, or null for none. `tellPeer` stops it at the peer,
   * when this side ends one that went out.
   */
  const finish = (subscription: Subscription, outcome: Outcome | null, tellPeer: boolean): void => {
    const was = leave(subscription, { name: 'ended' });
    if (was === null) {
      return;
    }
    subscription.closeListeners.length = 0;
    if (tellPeer && was === 'open') {
      postStop(subscription);
    }
    if (outcome !== null) {
      // An interrupt carries no value, which the wire has already checked.
      const end = outcome as Result<void, CallError<unknown>>;
      runListener(() => {
        subscription.listeners.interrupt(end);
      });
    }
  };

  /** Closes subscriptions with `error`, which their `onClose` listeners hear. Each open one is stopped first. */
  const shut = (closing: Subscription[], error: Error): void => {
    const closed: Subscription[] = [];
    for (const subscription of closing) {
      const was = leave(subscription, { name: 'closed', error });
      if (was === 'open') {
        postStop(subscription);
      }
      if (was !== null) {
        closed.push(subscription);
      }
    }
    for (const subscription of closed) {
      for (const listener of subscription.closeListeners.splice(0)) {
        runListener(() => {
          listener(error);
        });
      }
    }
  };

  /** The open subscription at `id` on `address`, or undefined. */
  const openAt = (id: number, address: Address): Subscription | undefined => {
    const subscription = subscriptions.get(id);
    return subscription?.state.name === 'open' &&
      subscription.trait === address.trait &&
      subscription.method === address.method
      ? subscription
      : undefined;
  };

  /** Reports a message on no open subscription of its method, unless it may have crossed this side's stop. */
  const refuseStray = ({ id, leg }: Header): void => {
    if (lateStops.has(id)) {
      return;
    }
    refuse(
      new Error(
        subscriptions.get(id)?.state.name === 'open'
          ? `The ${leg} leg for subscription ${String(id)} names another method than the subscription`
          : `A ${leg} leg names subscription ${String(id)}, which is not open on this side`,
      ),
    );
  };

  return {
    request(address, payload, signal) {
      return new Promise<Outcome>((resolve, reject) => {
        const closed = closedBy();
        if (closed !== null) {
          reject(closed);
          return;
        }
        if (signal?.aborted === true) {
          resolve(err(cancelled()));
          return;
        }
        // Aborted once the call settles, so a call settled while it waits leaves the queue and never goes out.
        const over = new AbortController();
        const onAbort = (): void => {
          call.settle(err(cancelled()));
        };
        const call: PendingRequest = {
          id: deps.nextId(),
          ...address,
          settle: outcome => {
            if (over.signal.aborted) {
              return;
            }
            over.abort();
            signal?.removeEventListener('abort', onAbort);
            if (waiting.get(call.id) === call) {
              waiting.delete(call.id);
            }
            if (outcome instanceof Error) {
              reject(outcome);
            } else {
              resolve(outcome);
            }
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        place(
          over.signal,
          () => {
            send(call, payload);
          },
          call.settle,
        );
      });
    },

    subscribe(address, start, listeners, signal) {
      const closed = closedBy();
      const subscription: Subscription = {
        id: deps.nextId(),
        ...address,
        state: closed === null ? { name: 'queued' } : { name: 'closed', error: closed },
        listeners,
        closeListeners: [],
        over: new AbortController(),
        detach: () => undefined,
      };
      const handle: SubscriptionHandle = {
        stop() {
          finish(subscription, null, true);
        },
        onClose(listener) {
          const { state } = subscription;
          if (state.name === 'closed') {
            runListener(() => {
              listener(state.error);
            });
          } else if (state.name !== 'ended') {
            subscription.closeListeners.push(listener);
          }
        },
      };
      if (closed !== null) {
        return handle;
      }
      // Encoded at once, so a start the wire refuses throws to the caller. It is posted once, so the buffer stays whole.
      const { id } = subscription;
      const data = encodeMessage(schema, { kind: 'method', leg: 'start', id, ...address, payload: start });
      const onAbort = (): void => {
        finish(subscription, err(cancelled()), true);
      };
      subscriptions.set(id, subscription);
      if (signal?.aborted === true) {
        // Heard on a microtask, so no listener runs before the caller holds its handle.
        queueMicrotask(onAbort);
        return handle;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      subscription.detach = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      place(
        subscription.over.signal,
        () => {
          lateStops.delete(id);
          const posted = post(data, address);
          if (!posted.ok) {
            shut([subscription], new Error('The start could not be posted', { cause: posted.error }));
            return;
          }
          // Open only once the start went out, so a stop or a close from the issue hook of a failed post sees nothing
          // the peer could stop.
          if (subscription.state.name === 'queued') {
            subscription.state = { name: 'open' };
          }
        },
        error => {
          shut([subscription], error);
        },
      );
      return handle;
    },

    onResponse(message) {
      answered(message.id, message)?.settle(message.outcome);
    },

    onReceive(message) {
      const subscription = openAt(message.id, message);
      if (subscription === undefined) {
        refuseStray(message);
        return;
      }
      runListener(() => {
        subscription.listeners.receive(message.payload);
      });
    },

    onInterrupt(message) {
      const subscription = openAt(message.id, message);
      if (subscription === undefined) {
        refuseStray(message);
        return;
      }
      finish(subscription, message.outcome, false);
    },

    onUndecodable(header, cause) {
      const outcome = err(malformedFrame(decodeReason(cause)));
      if (header.leg === 'response') {
        answered(header.id, header)?.settle(outcome);
        return;
      }
      if (header.leg !== 'interrupt' && header.leg !== 'receive') {
        return;
      }
      const subscription = openAt(header.id, header);
      if (subscription !== undefined) {
        // A lost value leaves the subscriber behind the peer, so the subscription ends and the peer is told to stop.
        finish(subscription, outcome, header.leg === 'receive');
      }
    },

    onProtocolError({ id, unsupportedMessage }) {
      if (waiting.has(id)) {
        answered(id, unsupportedMessage)?.settle(err(unsupported()));
        return;
      }
      const subscription = openAt(id, unsupportedMessage);
      if (subscription !== undefined) {
        finish(subscription, err(unsupported()), false);
      }
    },

    close(error) {
      for (const call of [...waiting.values()]) {
        call.settle(error);
      }
      shut([...subscriptions.values()], error);
    },
  };
}
