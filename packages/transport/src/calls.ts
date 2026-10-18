// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side makes: requests and subscriptions. Each waits for the handshake to be over, then goes out. What
// comes back carries the call's id, and the call decodes it with its own method's codec.

import type { ResultPayload } from 'scale-ts';
import { failureReason } from './errors.js';
import { REMEMBERED_ENDS, createRecentIds, encodeCall, type Post, type Refuse, type RunListener } from './parts.js';
import { cancelled, err, malformedFrame, type CallError, type Failure } from './result.js';
import type { Address, Request, Subscription } from './schema.js';
import { decode, type Call } from './wire.js';

/** What a subscriber hears: each value, then one end. */
export interface SubscriptionListeners<V, I> {
  receive(value: V): void;
  /** The peer's end, a failure the library answered with, or `Cancelled` or `MalformedFrame` raised on this side. */
  interrupt(outcome: ResultPayload<undefined, CallError<I>>): void;
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
  nextId: () => number;
  post: Post;
  /** Settles once the handshake succeeds or fails, or the transport closes. */
  handshakeOver: Promise<void>;
  /** The error the transport closed with, or null while it is open. */
  closedBy: () => Error | null;
  refuse: Refuse;
  runListener: RunListener;
}

export interface Calls {
  /** Resolves to the peer's outcome or `Cancelled`. Rejects with the closing error, or when the call cannot go out. */
  request<P, R, E>(
    method: Request<P, R, E>,
    address: Address,
    payload: P,
    signal: AbortSignal | undefined,
  ): Promise<ResultPayload<R, CallError<E>>>;
  /** Opens a subscription. Throws when the start does not encode. */
  subscribe<S, V, I>(
    method: Subscription<S, V, I>,
    address: Address,
    start: S,
    listeners: SubscriptionListeners<V, I>,
    signal: AbortSignal | undefined,
  ): SubscriptionHandle;
  /** Hands a message the peer sent on call `id` to the call. */
  hear(id: number, call: Call<Uint8Array>): void;
  /** Ends call `id` with a failure the peer answered it with. */
  fail(id: number, error: Failure): void;
  /**
   * Rejects every call that went out and is still waiting with `error`, and closes every subscription with it, telling
   * the peer to stop each open one. Calls still waiting for the handshake find the error as they leave.
   */
  close(error: Error): void;
}

/** A call that went out, as the peer's messages reach it. */
interface OutCall {
  address: Address;
  hear(message: Uint8Array): void;
  fail(error: Failure): void;
  close(error: Error): void;
}

export function createCalls(deps: CallsDeps): Calls {
  const { post, handshakeOver, closedBy, refuse, runListener } = deps;
  // The calls that went out and wait for the peer.
  const out = new Map<number, OutCall>();
  const ended = createRecentIds(REMEMBERED_ENDS);

  /**
   * Runs `send` once the handshake is over, unless the call ended meanwhile, or fails with the error the transport
   * closed with. Callbacks on one promise run in the order they were added, so calls go out in call order.
   */
  const place = (over: AbortSignal, send: () => void, fail: (error: Error) => void): void => {
    void handshakeOver.then(() => {
      if (over.aborted) {
        return;
      }
      const closed = closedBy();
      if (closed === null) {
        send();
      } else {
        fail(closed);
      }
    });
  };

  /** Reports a message on a call this side is not waiting on, unless it ended that call lately. */
  const refuseStray = (id: number): void => {
    if (!ended.has(id)) {
      refuse('invalid', new Error(`A message names call ${String(id)}, which this side is not waiting on`));
    }
  };

  return {
    request<P, R, E>(
      method: Request<P, R, E>,
      address: Address,
      payload: P,
      signal: AbortSignal | undefined,
    ): Promise<ResultPayload<R, CallError<E>>> {
      return new Promise<ResultPayload<R, CallError<E>>>((resolve, reject) => {
        const closed = closedBy();
        if (closed !== null) {
          reject(closed);
          return;
        }
        if (signal?.aborted === true) {
          resolve(err(cancelled()));
          return;
        }
        const id = deps.nextId();
        // Aborted once the call ends, so a call that ends while it waits never goes out.
        const over = new AbortController();
        /** Ends the call once. Returns whether it was still going. */
        const leave = (): boolean => {
          if (over.signal.aborted) {
            return false;
          }
          over.abort();
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
              answer(err(malformedFrame(failureReason(message.value))));
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
        place(
          over.signal,
          () => {
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
          },
          abandon,
        );
      });
    },

    subscribe<S, V, I>(
      method: Subscription<S, V, I>,
      address: Address,
      start: S,
      listeners: SubscriptionListeners<V, I>,
      signal: AbortSignal | undefined,
    ): SubscriptionHandle {
      const closed = closedBy();
      if (closed !== null) {
        return {
          stop: () => undefined,
          onClose(listener) {
            runListener(() => {
              listener(closed);
            });
          },
        };
      }
      let state: { name: 'queued' | 'open' | 'ended' } | { name: 'closed'; error: Error } = { name: 'queued' };
      const closeListeners: ((error: Error) => void)[] = [];
      const id = deps.nextId();
      // Aborted once the subscription leaves, so one still queued never goes out.
      const over = new AbortController();

      /** Takes the subscription out as `next`. Returns what it was, or null when it had already left. */
      const leave = (next: typeof state): 'queued' | 'open' | null => {
        const was = state.name;
        if (was !== 'queued' && was !== 'open') {
          return null;
        }
        state = next;
        over.abort();
        signal?.removeEventListener('abort', onAbort);
        out.delete(id);
        return was;
      };

      const postStop = (): void => {
        ended.add(id);
        const data = encodeCall(method, address, id, { tag: 'stop', value: undefined });
        if (data.success) {
          post(data.value, address);
        }
      };

      /** Ends the subscription once, with `outcome` for the listener, or none. `tellPeer` stops it at the peer. */
      const finish = (outcome: ResultPayload<undefined, CallError<I>> | null, tellPeer: boolean): void => {
        const was = leave({ name: 'ended' });
        if (was === null) {
          return;
        }
        closeListeners.length = 0;
        if (tellPeer && was === 'open') {
          postStop();
        }
        if (outcome !== null) {
          runListener(() => {
            listeners.interrupt(outcome);
          });
        }
      };

      /** Closes the subscription with `error`, which its `onClose` listeners hear. An open one is stopped first. */
      const shut = (error: Error): void => {
        const was = leave({ name: 'closed', error });
        if (was === null) {
          return;
        }
        if (was === 'open') {
          postStop();
        }
        for (const listener of closeListeners.splice(0)) {
          runListener(() => {
            listener(error);
          });
        }
      };

      const onAbort = (): void => {
        finish(err(cancelled()), true);
      };

      const handle: SubscriptionHandle = {
        stop() {
          finish(null, true);
        },
        onClose(listener) {
          if (state.name === 'closed') {
            const { error } = state;
            runListener(() => {
              listener(error);
            });
          } else if (state.name !== 'ended') {
            closeListeners.push(listener);
          }
        },
      };

      const call: OutCall = {
        address,
        hear(bytes) {
          const message = decode(method.message, bytes);
          if (!message.success) {
            // What was lost may be a value, which leaves the subscriber behind the peer, so the subscription ends and the
            // peer is told to stop. A stop after the peer's own end is a race it drops.
            refuse('malformed', message.value);
            finish(err(malformedFrame(failureReason(message.value))), true);
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
              finish(sent.value, false);
              return;
            case 'start':
            case 'stop':
              refuse('invalid', new Error(`A ${sent.tag} names subscription ${String(id)}, which this side made`));
          }
        },
        fail(error) {
          finish(err(error), false);
        },
        close: shut,
      };

      // Encoded at once, so a start the wire refuses throws to the caller. It is posted once, so the buffer stays whole.
      const data = encodeCall(method, address, id, { tag: 'start', value: start });
      if (!data.success) {
        throw data.value;
      }
      if (signal?.aborted === true) {
        // Heard on a microtask, so no listener runs before the caller holds its handle.
        queueMicrotask(onAbort);
        return handle;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      place(
        over.signal,
        () => {
          out.set(id, call);
          const posted = post(data.value, address);
          if (!posted.success) {
            shut(new Error('The start could not be posted', { cause: posted.value }));
            return;
          }
          // Open only once the start went out, so a stop or a close from the issue hook of a failed post sees nothing
          // the peer could stop.
          if (state.name === 'queued') {
            state = { name: 'open' };
          }
        },
        shut,
      );
      return handle;
    },

    hear(id, call) {
      const outCall = out.get(id);
      if (outCall === undefined) {
        refuseStray(id);
        return;
      }
      if (outCall.address.traitId !== call.trait || outCall.address.methodId !== call.method) {
        refuse('invalid', new Error(`A message for call ${String(id)} names another method than the call`));
        return;
      }
      outCall.hear(call.message);
    },

    fail(id, error) {
      const outCall = out.get(id);
      if (outCall === undefined) {
        refuseStray(id);
        return;
      }
      outCall.fail(error);
    },

    close(error) {
      for (const outCall of [...out.values()]) {
        outCall.close(error);
      }
    },
  };
}
