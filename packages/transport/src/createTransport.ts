// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One transport per provider for the provider's whole life, the same on every side. It reads each frame and hands it to
// the handshake, to the calls this side makes, or to the calls it serves. Each side numbers its own calls, the opener
// odd and the accepter even, so a frame's id tells whose call it is about. The transport owns whether it is open, and
// everything it cannot handle goes to the owner's issue hook.

import { toAbortError, type Timers } from '@dotli/shared';
import { createCallIds } from './createCallIds.js';
import { createConnection } from './createConnection.js';
import { createForwarding } from './createForwarding.js';
import { createHandshake } from './createHandshake.js';
import { createIssueReport } from './createIssueReport.js';
import { createOutgoingCalls } from './createOutgoingCalls.js';
import { createServedCalls } from './createServedCalls.js';
import { decodeOr } from './decodeOr.js';
import type { Schema, Sections } from './defineSchema.js';
import type { TransportIssue } from './describeIssue.js';
import { frameCodec, type Call } from './frame.js';
import { getFailureReason } from './getFailureReason.js';
import type { MessageBytes } from './messageBytes.js';
import type { Provider } from './provider.js';
import { registerUpstream } from './upstreams.js';

/** What a transport is built from: its schema, its provider, and how its side of the handshake runs. */
export type TransportParams<Hello, T extends Sections> = {
  /** The methods the transport calls and serves, and the codec of its hello. */
  schema: Schema<Hello, T>;
  /** The channel to the peer, which the transport disposes with itself. */
  provider: Provider;
  /** Which side opens the handshake. The other accepts it. */
  handshake: 'offer' | 'respond';
  /** This side's handshake value, encoded once. One its codec refuses throws at creation. */
  hello: Hello;
  /** How often the opener posts a fresh handshake offer until it is answered. */
  retryMs?: number | undefined;
  /**
   * How long the opener waits for an answer, on the running clock. Null sets no deadline, for an owner that bounds the
   * wait itself and disposes the transport when it gives up, so the wait has one deadline only.
   */
  timeoutMs?: number | null | undefined;
  /** The clock the opener's retries and deadline run on. */
  timers?: Timers | undefined;
  /** Hears what the transport cannot handle itself. With none, each issue is logged as an error. */
  onIssue?: ((issue: TransportIssue) => void) | undefined;
};

type RouteParams = {
  id: number;
  call: Call<MessageBytes>;
};

type WaitParams = {
  /** Gives up on this wait only: it rejects with an `AbortError`, and the handshake goes on for other callers. */
  signal?: AbortSignal | undefined;
};

/** Calls and serves the methods of one schema, whose hello is `Hello`. A method is passed as the schema holds it. */
export type Transport<Hello> = ReturnType<typeof createTransport<Hello, Sections>>;

/**
 * A transport over `provider` that calls and serves the methods of `schema`. Throws for a hello its codec refuses.
 *
 * @example
 * const transport = createTransport({ schema, provider, handshake: 'offer', hello: undefined });
 * const result = await transport.request(getAccount, 'alice');
 */
export function createTransport<Hello, T extends Sections>({
  schema,
  provider,
  ...options
}: TransportParams<Hello, T>) {
  const opens = options.handshake === 'offer';
  const ids = createCallIds({ opens });
  const issues = createIssueReport({ onIssue: options.onIssue });
  const connection = createConnection<Hello>({ provider, report: issues.report, onClose: closeAll });
  const handshake = createHandshake({
    schema,
    hello: options.hello,
    opens,
    retryMs: options.retryMs,
    timeoutMs: options.timeoutMs,
    timers: options.timers,
    connection,
    issues,
  });
  const outgoing = createOutgoingCalls({ schema, ids, connection, issues, startHandshake: handshake.start });
  const served = createServedCalls<Hello>({ schema, connection, issues });
  const forwarding = createForwarding({ schema, served, connection, issues });
  let disposed = false;

  // Providers do not buffer, so the listener is bound before anything can arrive.
  const unsubscribeProvider = provider.subscribe(handleData);
  // With no peer here the transport is closed from the start, so no handshake is posted.
  if (!provider.isCorrectEnvironment()) {
    connection.close(new Error('Environment is not correct'));
  }

  const transport = {
    /**
     * Starts the handshake on the opener, for a side that starts it before its first call. Does nothing on the
     * accepter, which waits for the opener.
     */
    connect,
    /**
     * Resolves once the handshake succeeds, and rejects with the closing error once the transport closes. Starts the
     * handshake on the opener, as `connect` does. Rejects with an `AbortError` once `signal` aborts, which ends this
     * wait only. A closed transport's error wins over a signal that already aborted.
     */
    whenConnected,
    /**
     * Calls the peer, and starts the handshake on the opener, as `connect` does. Resolves to its `Result`, or to
     * `Cancelled` once the signal aborts. Calls made before the handshake wait and go out in call order once it
     * succeeds. Rejects with the error the transport closed with, a post the provider throws on among them, with
     * `TransportMalformedResponseError` when the answer does not decode, or when the payload does not encode. Throws
     * at once, before any promise, for a method this schema lacks.
     */
    request: outgoing.request,
    /**
     * Serves one method. One handler per method, and calling the returned function unregisters it. Throws for a method
     * this schema lacks, and for a method that already has a handler.
     */
    handleRequest: served.handleRequest,
    /**
     * Subscribes to the peer, and starts the handshake on the opener, as `connect` does. Of its `listeners`, `receive`
     * hears each value, and `interrupt`, `fail` or `close` the one end. Subscriptions made before the handshake wait
     * and go out in call order with the requests. Returns `unsubscribe`, which stops it at the peer and calls no
     * listener. Throws for a method this schema lacks, and when the start does not encode.
     */
    subscribe: outgoing.subscribe,
    /**
     * Serves one subscription method. One handler per method, and calling the returned function unregisters it. Throws
     * for a method this schema lacks, and for a method that already has a handler.
     */
    handleSubscription: served.handleSubscription,
    /**
     * Serves each of `methods` by forwarding the peer's calls to `upstream` as their message bytes, and the answers
     * back. A forwarded call waits for `upstream`'s handshake like its own calls, and is answered `HostFailure` with
     * the closing error when `upstream` closes under it. Returns what stops forwarding them, which leaves the open
     * calls to run to their end. Throws for a method `upstream` does not place at the same ids, for an `upstream` this
     * library did not build, and for a method that already has a handler.
     */
    forward: forwarding.forward,
    /**
     * Closes this side, and posts nothing. Every subscription it serves stops, every one it made hears `close(reason)`,
     * every pending and later request rejects with `reason`, and the provider is disposed.
     */
    dispose,
  };
  registerUpstream(transport, { addressOf: schema.addressOf, open: outgoing.open });
  return transport;

  function connect(): void {
    handshake.start();
  }

  async function whenConnected({ signal }: WaitParams = {}): Promise<void> {
    // A closed transport is never a wait outcome, so its error wins over an aborted signal.
    throwIfClosed();
    handshake.start();
    await (signal === undefined ? connection.whenOver : waitForHandshake(signal));
    throwIfClosed();
  }

  function throwIfClosed(): void {
    const phase = connection.getPhase();
    if (phase.name === 'closed') {
      throw phase.error;
    }
  }

  /** Resolves once the handshake is over, and rejects with an `AbortError` once `signal` aborts first. */
  function waitForHandshake(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      function abort(): void {
        reject(toAbortError(signal.reason, 'The wait for the handshake was aborted'));
      }

      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      void connection.whenOver.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
    });
  }

  function dispose(reason: Error): void {
    if (disposed) {
      return;
    }
    disposed = true;
    connection.close(reason);
    unsubscribeProvider();
    provider.dispose();
  }

  /** Ends every call once the transport closes: the served calls drop first, then this side's calls close. */
  function closeAll(error: Error): void {
    served.dropAll();
    outgoing.closeAll(error);
  }

  // Nothing thrown while a frame is handled reaches the provider, whose other listeners must still hear it.
  function handleData(data: Uint8Array): void {
    try {
      receive(data);
    } catch (error) {
      issues.refuse('invalid', new Error('The message could not be handled', { cause: error }));
    }
  }

  /** Reads a frame and hands it to the handshake, to the call this side made, or to the call it serves. */
  function receive(data: Uint8Array): void {
    const frame = decodeOr({
      decoder: frameCodec.dec,
      data,
      onError: error => {
        issues.refuse('malformed', error);
      },
    });
    if (frame === undefined) {
      return;
    }
    const { id, body } = frame;
    const phase = connection.getPhase();
    switch (body.tag) {
      case 'handshakeOffer':
        if (opens) {
          issues.refuse('invalid', new Error('A handshake offer reached the side that opens the handshake'));
        } else if (phase.name === 'closed') {
          issues.refuse(
            'invalid',
            new Error(`A handshake offer came after the transport closed, ${getFailureReason(phase.error)}`),
          );
        } else {
          handshake.hearOffer(id, body.value);
        }
        return;
      case 'handshakeResponse':
        if (opens) {
          handshake.hearResponse(body.value);
        } else {
          issues.refuse('invalid', new Error('A handshake answer reached the side that accepts the handshake'));
        }
        return;
      case 'failed':
        outgoing.fail(id, body.value);
        return;
      case 'call':
        if (ids.isOwn(id)) {
          outgoing.hear(id, body.value);
          return;
        }
        routeCall({ id, call: body.value });
    }
  }

  /** Hands a call of the peer's to the calls this side serves, by the phase the transport is in. */
  function routeCall({ id, call }: RouteParams): void {
    const phase = connection.getPhase();
    switch (phase.name) {
      case 'connected':
        served.hear({ id, call, context: { hello: phase.peerHello } });
        return;
      case 'connecting':
        // The peer acts on this side only once the handshake told who it is.
        served.answerEarly(id, call);
        return;
      case 'closed':
        issues.refuse('invalid', new Error(`A call came after the transport closed, ${getFailureReason(phase.error)}`));
    }
  }
}
