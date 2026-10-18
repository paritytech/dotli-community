// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side makes: requests and subscriptions. Each waits for the handshake to be over, then goes out. What
// comes back carries the call's id, and the call decodes it with its own method's codec.

import type { ResultPayload } from 'scale-ts';
import type { Post, Refuse, RunListener } from './parts.js';
import { createRecentIds } from './recent-ids.js';
import { cancelled, err, malformedFrame, type CallError, type Failure } from './result.js';
import { sameMethod, type Address, type Request, type Subscription } from './schema.js';
import { decode, encodeCall, type Call } from './wire.js';

/** What a subscriber hears: each value, then one end, unless it stops first. */
export interface SubscriptionListeners<V, I> {
  receive(value: V): void;
  /** The peer's end, a failure the library answered with, or `Cancelled` or `MalformedFrame` raised on this side. */
  interrupt(outcome: ResultPayload<undefined, CallError<I>>): void;
  /** The end raised on this side with an error: the transport closed, or the start could not be posted. */
  close(error: Error): void;
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
  /** Opens a subscription, and returns what stops it. Throws when the start does not encode. */
  subscribe<S, V, I>(
    method: Subscription<S, V, I>,
    address: Address,
    start: S,
    listeners: SubscriptionListeners<V, I>,
    signal: AbortSignal | undefined,
  ): () => void;
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
  const ended = createRecentIds();

  /**
   * Runs `send` once the handshake is over, or fails with the error the transport closed with. Each does nothing for a
   * call that ended meanwhile. Callbacks on one promise run in the order they were added, so calls go out in call order.
   */
  const place = (send: () => void, fail: (error: Error) => void): void => {
    void handshakeOver.then(() => {
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
        // A closed transport is never a call outcome, so its error wins over an aborted signal.
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
    },

    subscribe<S, V, I>(
      method: Subscription<S, V, I>,
      address: Address,
      start: S,
      listeners: SubscriptionListeners<V, I>,
      signal: AbortSignal | undefined,
    ): () => void {
      let state: 'queued' | 'open' | 'ended' = 'queued';
      const id = deps.nextId();

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
    },

    hear(id, call) {
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
