// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One side opens the handshake and the other accepts it. The opener posts a fresh attempt every `retryMs` until an
// answer comes or `timeoutMs` passes, since the accepter may not be listening yet. Each side tells the transport once
// whether the peer is there and what its hello is.

import { createAsyncTaskPool, toError, withTimeout, type Timers } from '@dotli/shared';
import { TransportHandshakeTimeoutError, TransportVersionMismatchError } from './errors.js';
import type { Post } from './parts.js';
import { err, ok, type Result } from './result.js';
import { LIBRARY_TRAIT, type Leg, type Message, type Wire } from './wire.js';

export interface HandshakeDeps {
  wire: Wire;
  /** The schema version this side speaks. */
  version: number;
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
  hear(message: Message): void;
  /** Stops the opener's attempts and timeout. */
  stop(reason: Error): void;
}

/** An attempt: the opener's version, and its hello, read only when the version is this side's. */
interface HandshakeAttempt {
  version: number;
  hello: unknown;
}

/** The accepter's hello, or the version it speaks. */
type HandshakeAnswer = Result<unknown, { tag: 'VersionMismatch'; value: { version: number } }>;

const versionMismatch = (version: number) => ({ tag: 'VersionMismatch' as const, value: { version } });

const handshake = (id: number, leg: Leg, value: HandshakeAttempt | HandshakeAnswer): Message => ({
  id,
  trait: LIBRARY_TRAIT,
  method: 'handshake',
  leg,
  value,
});

/** Fails an attempt so the pool tries again. Any other failure ends the handshake. */
class HandshakeUnansweredError extends Error {}

export function createOpener(deps: HandshakeDeps & { retryMs: number; timeoutMs: number; timers: Timers }): Handshake {
  const { version, retryMs, timeoutMs, timers } = deps;
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
    const data = deps.wire.encode(handshake(deps.nextId(), 'request', { version, hello: deps.hello }));
    const posted = deps.post(data);
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
      const answer = message.value as HandshakeAnswer;
      finish(
        answer.ok ? ok(answer.value) : err(new TransportVersionMismatchError(version, answer.error.value.version)),
      );
    },

    stop(reason) {
      stopAttempts.abort(reason);
    },
  };
}

export function createAccepter(deps: HandshakeDeps): Handshake {
  const { version } = deps;
  // The answer to the first attempt whose answer was posted, which every later attempt hears again.
  let first: HandshakeAnswer | undefined;

  return {
    start() {
      // The opener starts the handshake.
    },

    hear(message) {
      if (message.leg === 'response') {
        deps.refuse(new Error('A handshake response reached the side that accepts the handshake'));
        return;
      }
      const attempt = message.value as HandshakeAttempt;
      const deciding = first === undefined;
      const answer = first ?? (attempt.version === version ? ok(deps.hello) : err(versionMismatch(version)));
      let data: ArrayBuffer;
      try {
        data = deps.wire.encode(handshake(message.id, 'response', answer));
      } catch (error) {
        deps.onFail(new Error('The handshake answer could not be encoded', { cause: error }));
        return;
      }
      // An answer the opener never heard decides nothing, so its next attempt is answered afresh.
      if (!deps.post(data).ok || !deciding) {
        return;
      }
      first = answer;
      if (answer.ok) {
        deps.onOpen(attempt.hello);
      } else {
        deps.onFail(new TransportVersionMismatchError(version, attempt.version));
      }
    },

    stop() {
      // The accepter runs nothing between attempts.
    },
  };
}
