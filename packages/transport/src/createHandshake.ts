// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One side opens the handshake and the other accepts it. The opener posts a fresh attempt every `retryMs` until an
// answer comes or `timeoutMs` passes, since the accepter may not be listening yet. Each side settles the handshake
// once, with whether the peer is there and what its hello is. Both the library's wire version and the schema's must
// match.

import { createAsyncTaskPool, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import { WIRE_VERSION } from './constants.js';
import type { Connection } from './createConnection.js';
import type { IssueReport } from './createIssueReport.js';
import { createWholeDecoder } from './createWholeDecoder.js';
import type { Schema, Sections } from './defineSchema.js';
import { encodeFrame } from './frame.js';
import type { HandshakeOffer, HandshakeResponse, TransportVersions } from './handshakeCodecs.js';
import { getFailureReason } from './getFailureReason.js';
import { err, ok } from './result.js';
import { TransportHandshakeTimeoutError } from './transportHandshakeTimeoutError.js';
import { TransportUnsupportedProtocolVersionError } from './transportUnsupportedProtocolVersionError.js';

type Params<Hello> = {
  /** The codec of both sides' hello, and the schema version both sides must share. */
  schema: Pick<Schema<Hello, Sections>, 'hello' | 'version'>;
  /** This side's hello, encoded once. One its codec refuses throws at creation. */
  hello: Hello;
  /** Whether this side opens the handshake. The other accepts it. */
  opens: boolean;
  /** How often the opener posts a fresh attempt until one is answered. */
  retryMs?: number | undefined;
  /** How long the opener waits for an answer, on the running clock. Null sets no deadline. */
  timeoutMs?: number | null | undefined;
  /** The clock the opener's retries and deadline run on. */
  timers?: Timers | undefined;
  /** Posts the attempts and answers, and settles the handshake: connected with the peer's hello, or closed. */
  connection: Connection<Hello>;
  /** Hears a handshake message this side refuses. */
  issues: IssueReport;
};

const DEFAULT_RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;

/** The handshake of one transport, on the side that opens it or the side that accepts it. */
export function createHandshake<Hello>({
  schema,
  hello,
  opens,
  retryMs = DEFAULT_RETRY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timers = realTimers,
  connection,
  issues,
}: Params<Hello>) {
  // Encoded once, so neither side encodes it per handshake, and a hello its codec refuses throws here.
  const ourHello = schema.hello.enc(hello);
  // Built once, so no handshake composes a decoder.
  const wholeHello = createWholeDecoder(schema.hello);
  const ours: TransportVersions = { wire: WIRE_VERSION, schema: schema.version };
  const attempts = createAsyncTaskPool({
    poolSize: 1,
    retryCount: Number.POSITIVE_INFINITY,
    retryDelay: retryMs,
    retryIf: error => error instanceof HandshakeUnansweredError,
    timers,
  });
  let started = false;

  /** Starts the opener's handshake once, unless the transport closed. Does nothing on the accepter. Never throws. */
  function start(): void {
    if (!opens || started || connection.stopSignal.aborted) {
      return;
    }
    started = true;
    // An attempt fails until an answer comes, so the pool posts a fresh one every `retryMs` until it is stopped. It
    // settles only when stopped, or when an attempt cannot be posted.
    const retrying = attempts.call<never>(attempt, { signal: connection.stopSignal });
    const answered =
      timeoutMs === null
        ? retrying
        : withTimeout({
            work: retrying,
            ms: timeoutMs,
            timeoutError: () =>
              new TransportHandshakeTimeoutError(`No handshake answer within ${String(timeoutMs)} ms`),
            timers,
          });
    answered.catch((error: unknown) => {
      fail(toError(error));
    });
  }

  /** Hears the accepter's answer on the opener. Only the first answer counts, and the rest answer later attempts. */
  function hearResponse(response: HandshakeResponse): void {
    if (!started) {
      issues.refuse('invalid', new Error('A handshake answer came to a side that has not opened a handshake'));
      return;
    }
    if (!response.success) {
      fail(new TransportUnsupportedProtocolVersionError(ours, response.value));
      return;
    }
    const peer = readHello(response.value);
    if (peer !== null) {
      connection.connect(peer.hello);
    }
  }

  /**
   * Hears the opener's attempt `id` on the accepter, and answers it. A failed answer and a failed post each close this
   * side, so a later attempt is answered only once the first connected.
   */
  function hearOffer(id: number, offer: HandshakeOffer): void {
    if (opens) {
      issues.refuse('invalid', new Error('A handshake offer reached the side that opens the handshake'));
      return;
    }
    const phase = connection.getPhase();
    switch (phase.name) {
      case 'closed':
        issues.refuse(
          'invalid',
          new Error(`A handshake offer came after the transport closed, ${getFailureReason(phase.error)}`),
        );
        return;
      case 'connected':
        // A later attempt of the opener's, posted before it heard the first answer.
        answerOffer(id, ok(ourHello));
        return;
      case 'connecting':
        break;
    }
    if (!isSameVersions(offer.versions)) {
      answerOffer(id, err(ours));
      fail(new TransportUnsupportedProtocolVersionError(ours, offer.versions));
      return;
    }
    // A hello is decoded only at the same versions, since another release's may not decode.
    const peer = readHello(offer.hello);
    if (peer !== null) {
      // A post the provider throws on closes this side, so the connect after it does nothing.
      answerOffer(id, ok(ourHello));
      connection.connect(peer.hello);
    }
  }

  function answerOffer(id: number, answer: HandshakeResponse): void {
    connection.post({ data: encodeFrame({ id, body: { tag: 'handshakeResponse', value: answer } }) });
  }

  // An attempt is no call, so it takes no call id, and the accepter's answer echoes it. The frame is built anew each
  // time, since the provider may transfer its buffer.
  function attempt(): never {
    const offer = { versions: ours, hello: ourHello };
    if (connection.post({ data: encodeFrame({ id: 0, body: { tag: 'handshakeOffer', value: offer } }) })) {
      throw new HandshakeUnansweredError('The handshake is not answered yet');
    }
    // A post that fails closes the transport with why, so this error only ends the attempts.
    throw new Error('The handshake offer was not posted');
  }

  /**
   * The peer's hello, or null when it does not decode, which is refused. Wrapped, since a hello may decode to
   * undefined.
   */
  function readHello(bytes: Uint8Array): { hello: Hello } | null {
    try {
      return { hello: wholeHello(bytes) };
    } catch (error) {
      issues.refuse('malformed', toError(error));
      return null;
    }
  }

  /** Ends a handshake that is still going with `error`, which closes the transport. A settled one ignores it. */
  function fail(error: Error): void {
    if (connection.getPhase().name !== 'connecting') {
      return;
    }
    connection.close(error);
  }

  function isSameVersions(theirs: TransportVersions): boolean {
    return theirs.wire === ours.wire && theirs.schema === ours.schema;
  }

  return { start, hearOffer, hearResponse };
}

/** Fails a handshake attempt so the pool tries again. Any other failure ends the handshake. */
class HandshakeUnansweredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandshakeUnansweredError';
  }
}
