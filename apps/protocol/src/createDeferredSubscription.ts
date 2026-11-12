// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription accepted before what feeds it has loaded, since a refusal then would never be retried on that frame.

import type { ProtocolContext, ProtocolHello, SubscriptionEnd } from '@dotli/protocol';
import { toError } from '@dotli/shared';
import { err, hostFailure, type Sink, type SubscriptionHandler } from '@dotli/transport';

type Handler<Start, Value, Domain> = SubscriptionHandler<Start, Value, SubscriptionEnd<Domain>, ProtocolHello>;

type Waiting<Start, Value, Domain> = {
  start: Start;
  context: ProtocolContext;
  sink: Sink<Value, SubscriptionEnd<Domain>>;
  /** Null until the source starts it. */
  stop: (() => void) | null;
  /** Stopped by the peer, an interrupt or a dispose, which may come while the source starts. */
  stopped: boolean;
};

/** A subscription served at once, whose source comes later. */
export type DeferredSubscription<Start, Value, Domain> = ReturnType<
  typeof createDeferredSubscription<Start, Value, Domain>
>;

/** A subscription served at once, which waits for its source. */
export function createDeferredSubscription<Start, Value, Domain>() {
  let startSource: Handler<Start, Value, Domain> | null = null;
  const waiting = new Set<Waiting<Start, Value, Domain>>();

  return {
    /**
     * Registered at once. Each subscription waits until `serve`, and one that stops first never starts. Throws what the
     * source throws on start once it is served.
     */
    accept: acceptSubscription,
    /**
     * Starts every waiting subscription on `handler`, and every later one at once. Only the first `serve` or `fail`
     * counts. A waiting subscription whose start throws ends with the error.
     */
    serve,
    /**
     * Ends every waiting subscription with `error`, and every later one at once, for a source that will never come.
     */
    fail,
  };

  function run(entry: Waiting<Start, Value, Domain>, handler: Handler<Start, Value, Domain>): void {
    const stop = handler(entry.start, entry.context, entry.sink);
    if (entry.stopped) {
      stop();
    } else {
      entry.stop = stop;
    }
  }

  function serve(handler: Handler<Start, Value, Domain>): void {
    if (startSource !== null) {
      return;
    }
    startSource = handler;
    const started = [...waiting];
    waiting.clear();
    for (const entry of started) {
      try {
        run(entry, handler);
      } catch (error) {
        entry.sink.interrupt(err(hostFailure(toError(error))));
      }
    }
  }

  function acceptSubscription(
    start: Start,
    context: ProtocolContext,
    sink: Sink<Value, SubscriptionEnd<Domain>>,
  ): () => void {
    const entry: Waiting<Start, Value, Domain> = { start, context, sink, stop: null, stopped: false };
    if (startSource === null) {
      waiting.add(entry);
    } else {
      run(entry, startSource);
    }
    return stopEntry;

    function stopEntry(): void {
      entry.stopped = true;
      waiting.delete(entry);
      entry.stop?.();
    }
  }

  function fail(error: Error): void {
    serve(() => {
      throw error;
    });
  }
}
