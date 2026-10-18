// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One side opens the handshake and the other accepts it. The opener posts a fresh attempt every `retryMs` until an
// answer comes or `timeoutMs` passes, since the accepter may not be listening yet. Each side tells the transport once
// whether the peer is there and what its hello is.

import { createAsyncTaskPool, toError, withTimeout, type Timers } from '@dotli/shared';
import type { Codec, ResultPayload } from 'scale-ts';
import { TransportHandshakeTimeoutError, TransportVersionMismatchError } from './errors.js';
import type { Post, Refuse } from './parts.js';
import { err, ok } from './result.js';
import { decode, encodeFrame, frame, type Accept, type Open } from './wire.js';

export interface HandshakeDeps<H> {
  /** The schema version this side speaks. */
  version: number;
  helloCodec: Codec<H>;
  /** This side's hello. */
  hello: H;
  post: Post;
  /** Reports a handshake frame meant for the other role, or one whose hello does not decode. */
  refuse: Refuse;
  /** Called once the peer is there, with its hello. */
  onOpen: (peerHello: H) => void;
  /** Called once the handshake has failed, with why. */
  onFail: (error: Error) => void;
}

export interface Handshake {
  heardOpen(id: number, open: Open): void;
  heardAccept(accept: Accept): void;
}

/** The side that opens the handshake. */
export interface Opener extends Handshake {
  /** Starts the attempts. Does nothing once started. */
  start(): void;
  /** Stops the attempts and the timeout. */
  stop(reason: Error): void;
}

/** Fails an attempt so the pool tries again. Any other failure ends the handshake. */
class HandshakeUnansweredError extends Error {}

export function createOpener<H>(
  deps: HandshakeDeps<H> & { retryMs: number; timeoutMs: number; timers: Timers },
): Opener {
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
  const finish = (outcome: ResultPayload<H, Error>): void => {
    if (phase !== 'waiting') {
      return;
    }
    phase = 'over';
    if (outcome.success) {
      stopAttempts.abort();
      deps.onOpen(outcome.value);
    } else {
      stopAttempts.abort(outcome.value);
      deps.onFail(outcome.value);
    }
  };

  // An attempt is no call, so it takes no call id, and the accepter's answer echoes it.
  const attempt = (): never => {
    const hello = deps.helloCodec.enc(deps.hello);
    const data = encodeFrame(frame, { id: 0, body: { tag: 'open', value: { version, hello } } });
    const posted = deps.post(data);
    if (!posted.success) {
      throw new Error('The handshake could not be posted', { cause: posted.value });
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
      // settles only when stopped, or when an attempt cannot encode its hello or be posted.
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

    heardOpen() {
      deps.refuse('invalid', new Error('A handshake open reached the side that opens the handshake'));
    },

    heardAccept(accept) {
      if (phase === 'idle') {
        deps.refuse('invalid', new Error('A handshake answer came before this side opened the handshake'));
        return;
      }
      // Only the first answer counts. The rest answer attempts already in flight.
      if (!accept.success) {
        finish(err(new TransportVersionMismatchError(version, accept.value.version)));
        return;
      }
      const hello = decode(deps.helloCodec, accept.value);
      if (!hello.success) {
        deps.refuse('malformed', hello.value);
        return;
      }
      finish(hello);
    },

    stop(reason) {
      stopAttempts.abort(reason);
    },
  };
}

export function createAccepter<H>(deps: HandshakeDeps<H>): Handshake {
  const { version } = deps;
  // The answer to the first attempt whose answer was posted, which every later attempt hears again.
  let first: Accept | undefined;

  return {
    heardOpen(id, open) {
      const sameVersion = open.version === version;
      const peerHello = sameVersion ? decode(deps.helloCodec, open.hello) : undefined;
      if (peerHello?.success === false) {
        deps.refuse('malformed', peerHello.value);
        return;
      }
      const deciding = first === undefined;
      let answer: Accept;
      try {
        answer = first ?? (sameVersion ? ok(deps.helloCodec.enc(deps.hello)) : err({ version }));
      } catch (error) {
        deps.onFail(new Error('The handshake answer could not be encoded', { cause: error }));
        return;
      }
      // An answer the opener never heard decides nothing, so its next attempt is answered afresh.
      const posted = deps.post(encodeFrame(frame, { id, body: { tag: 'accept', value: answer } }));
      if (!posted.success || !deciding) {
        return;
      }
      first = answer;
      if (peerHello === undefined) {
        deps.onFail(new TransportVersionMismatchError(version, open.version));
      } else {
        deps.onOpen(peerHello.value);
      }
    },

    heardAccept() {
      deps.refuse('invalid', new Error('A handshake answer reached the side that accepts the handshake'));
    },
  };
}
