// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One side opens the handshake and the other accepts it. The opener posts a fresh attempt every `retryMs` until an
// answer comes or `timeoutMs` passes, since the accepter may not be listening yet. Each side tells the transport once
// whether the peer is there and what its hello is.

import { createAsyncTaskPool, toError, withTimeout, type Timers } from '@dotli/shared';
import { TransportHandshakeTimeoutError, TransportVersionMismatchError } from './errors.js';
import type { Post } from './parts.js';
import { err, ok, type Result } from './result.js';
import { schemaVersion, type Schema } from './schema.js';
import { encodeMessage, type HandshakeMessage } from './wire.js';

export interface HandshakeDeps {
  schema: Schema;
  /** This side's hello. */
  hello: unknown;
  nextId: () => number;
  post: Post;
  /** Reports a handshake leg meant for the other role. */
  refuse: (cause: Error) => void;
  /** Called once the peer is there, with its hello. */
  onOpen: (peerHello: unknown) => void;
  /** Called once the handshake has failed, with why. */
  onFail: (error: Error) => void;
}

export interface Handshake {
  /** Starts the opener's attempts. Does nothing on the accepter or once started. */
  start(): void;
  hear(message: HandshakeMessage): void;
  /** Stops the opener's attempts and timeout. */
  stop(reason: Error): void;
}

/** Fails an attempt so the pool tries again. Any other failure ends the handshake. */
class HandshakeUnansweredError extends Error {}

export function createOpener(deps: HandshakeDeps & { retryMs: number; timeoutMs: number; timers: Timers }): Handshake {
  const { schema, retryMs, timeoutMs, timers } = deps;
  const version = schemaVersion(schema);
  const attempts = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: retryMs,
    retryIf: error => error instanceof HandshakeUnansweredError,
    timers,
  });
  const stopAttempts = new AbortController();
  let phase: 'idle' | 'waiting' | 'over' = 'idle';

  // Settles the handshake once. An answer settles it in the turn it arrives, so a call the accepter makes right after
  // its answer finds this side open.
  const finish = (outcome: Result<unknown, Error>): void => {
    if (phase !== 'waiting') {
      return;
    }
    phase = 'over';
    if (outcome.ok) {
      stopAttempts.abort();
      deps.onOpen(outcome.value);
    } else {
      stopAttempts.abort(outcome.error);
      deps.onFail(outcome.error);
    }
  };

  const attempt = (): never => {
    const data = encodeMessage(schema, {
      kind: 'handshake',
      leg: 'request',
      id: deps.nextId(),
      version,
      hello: deps.hello,
    });
    const posted = deps.post(data, 'request');
    if (!posted.ok) {
      throw new Error('The handshake could not be posted', { cause: posted.error });
    }
    throw new HandshakeUnansweredError('The handshake is not answered yet');
  };

  return {
    start() {
      if (phase !== 'idle' || stopAttempts.signal.aborted) {
        return;
      }
      phase = 'waiting';
      // An attempt fails until an answer comes, so the pool posts a fresh one every `retryMs` until it is stopped. It
      // settles only when stopped or when an attempt cannot be posted.
      const retrying = attempts.call<never>(attempt, { signal: stopAttempts.signal });
      withTimeout(
        retrying,
        timeoutMs,
        () => new TransportHandshakeTimeoutError(`No handshake answer within ${String(timeoutMs)} ms`),
        timers,
      ).catch((error: unknown) => {
        finish(err(toError(error)));
      });
    },

    hear(message) {
      if (message.leg === 'request') {
        deps.refuse(new Error('A handshake request reached the side that opens the handshake'));
        return;
      }
      if (phase === 'idle') {
        deps.refuse(new Error('A handshake answer came before this side opened the handshake'));
        return;
      }
      // Only the first answer counts. The rest answer attempts already in flight.
      const { outcome } = message;
      finish(outcome.ok ? ok(outcome.value) : err(new TransportVersionMismatchError(version, outcome.error.version)));
    },

    stop(reason) {
      stopAttempts.abort(reason);
    },
  };
}

export function createAccepter(deps: HandshakeDeps): Handshake {
  const { schema } = deps;
  const version = schemaVersion(schema);
  // The outcome of the first attempt whose answer was posted, which every later attempt hears again.
  let first: Result<unknown, { version: number }> | undefined;

  return {
    start() {
      // The opener starts the handshake.
    },

    hear(message) {
      if (message.leg === 'response') {
        deps.refuse(new Error('A handshake response reached the side that accepts the handshake'));
        return;
      }
      const deciding = first === undefined;
      const outcome = first ?? (message.version === version ? ok(deps.hello) : err({ version }));
      let data: ArrayBuffer;
      try {
        data = encodeMessage(schema, { kind: 'handshake', leg: 'response', id: message.id, outcome });
      } catch (error) {
        deps.onFail(new Error('The handshake answer could not be encoded', { cause: error }));
        return;
      }
      // An answer the opener never heard decides nothing, so its next attempt is answered afresh.
      if (!deps.post(data, 'response').ok || !deciding) {
        return;
      }
      first = outcome;
      if (outcome.ok) {
        deps.onOpen(message.hello);
      } else {
        deps.onFail(new TransportVersionMismatchError(version, message.version));
      }
    },

    stop() {
      // The accepter runs nothing between attempts.
    },
  };
}
