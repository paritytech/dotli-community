// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side makes. Each waits in a task pool until the handshake is over, then goes out, and its answer is
// matched to it by id. Every post encodes a fresh buffer, since a transferred one is detached.

import { createAsyncTaskPool, toError } from '@dotli/shared';
import { cancelled, err, unsupported, type CallError, type Result } from './result.js';
import type { Schema } from './schema.js';
import { encodeMessage, type Leg, type MethodMessage, type ProtocolErrorMessage } from './wire.js';

type Outcome = Result<unknown, CallError<unknown>>;

export interface Address {
  trait: number;
  method: number;
}

export interface CallsDeps {
  schema: Schema;
  nextId: () => number;
  /** Posts bytes. A post the provider throws on is already reported when it returns the error. */
  post: (data: ArrayBuffer, leg: Leg) => Result<void, unknown>;
  /** Settles once the handshake succeeds or fails, or the transport closes. */
  handshakeOver: Promise<void>;
  /** The error the transport closed with, or null while it is open. */
  closedBy: () => Error | null;
  /** Reports an answer that does not fit the call it names. */
  refuse: (cause: Error) => void;
}

export interface Calls {
  /** Resolves to the peer's outcome or `Cancelled`. Rejects with the closing error, or when the call cannot go out. */
  request(address: Address, payload: unknown, signal: AbortSignal | undefined): Promise<Outcome>;
  onResponse(message: Extract<MethodMessage, { outcome: unknown }>): void;
  onProtocolError(message: ProtocolErrorMessage): void;
  /** Rejects every call that went out and is still waiting with `error`. Calls still queued find it as they leave. */
  close(error: Error): void;
}

interface PendingRequest extends Address {
  id: number;
  /** Settles the call once. Later outcomes change nothing. */
  settle: (outcome: Outcome | Error) => void;
}

export function createCalls(deps: CallsDeps): Calls {
  const { schema, post, handshakeOver, closedBy, refuse } = deps;
  const waiting = new Map<number, PendingRequest>();
  // Every call waits here for the handshake to be over. It is unbounded, so calls run side by side once it is. Each call
  // is posted one step after it was made or after the handshake ended, whichever is later, so calls go out in call order
  // across the handshake, and a call made while the queue flushes goes out behind it.
  const queue = createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY });

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
    const posted = post(data, 'request');
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
        queue
          .call(
            async () => {
              await handshakeOver;
              // The queue has already rejected a call settled while it waited, and whatever settled it is its outcome.
              if (over.signal.aborted) {
                return;
              }
              const closedNow = closedBy();
              if (closedNow !== null) {
                throw closedNow;
              }
              send(call, payload);
            },
            { signal: over.signal },
          )
          .catch((error: unknown) => {
            call.settle(toError(error));
          });
      });
    },

    onResponse(message) {
      answered(message.id, message)?.settle(message.outcome);
    },

    onProtocolError(message) {
      answered(message.id, message.unsupportedMessage)?.settle(err(unsupported()));
    },

    close(error) {
      for (const call of [...waiting.values()]) {
        call.settle(error);
      }
    },
  };
}
