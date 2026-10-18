// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription the frame accepts before what feeds it has loaded. The host subscribes as soon as the handshake is
// answered, and a refusal then would never be retried on that frame.

import type { ProtocolContext, ProtocolHello } from '@dotli/protocol';
import { toError } from '@dotli/shared';
import { err, hostFailure, type Sink, type SubscriptionHandler } from '@dotli/transport';

type Handler<St, V, I> = SubscriptionHandler<St, V, I, ProtocolHello>;

interface Waiting<St, V, I> {
  start: St;
  context: ProtocolContext;
  sink: Sink<V, I>;
  /** Null until the real handler starts it. */
  stop: (() => void) | null;
  /** Stopped by the peer, an interrupt or a dispose, which may come while the real handler runs. */
  stopped: boolean;
}

export interface DeferredSubscription<St, V, I> {
  /** Registered at once. Each subscription waits until `serve`, and one that stops first never starts. */
  handler: Handler<St, V, I>;
  /** Starts every waiting subscription on `real`, and every later one at once. Only the first `serve` or `fail` counts. */
  serve(real: Handler<St, V, I>): void;
  /** Ends every waiting subscription with `error`, and every later one at once, for a source that will never come. */
  fail(error: Error): void;
}

export function createDeferredSubscription<St, V, I>(): DeferredSubscription<St, V, I> {
  let real: Handler<St, V, I> | null = null;
  const waiting = new Set<Waiting<St, V, I>>();

  const run = (entry: Waiting<St, V, I>, handler: Handler<St, V, I>): void => {
    const stop = handler(entry.start, entry.context, entry.sink);
    if (entry.stopped) {
      stop();
    } else {
      entry.stop = stop;
    }
  };

  const serve = (handler: Handler<St, V, I>): void => {
    if (real !== null) {
      return;
    }
    real = handler;
    const started = [...waiting];
    waiting.clear();
    for (const entry of started) {
      try {
        run(entry, handler);
      } catch (error) {
        // Ends it as the transport ends a subscription whose handler throws on start.
        entry.sink.interrupt(err(hostFailure(toError(error))));
      }
    }
  };

  return {
    handler: (start, context, sink) => {
      const entry: Waiting<St, V, I> = { start, context, sink, stop: null, stopped: false };
      if (real === null) {
        waiting.add(entry);
      } else {
        run(entry, real);
      }
      return () => {
        entry.stopped = true;
        waiting.delete(entry);
        entry.stop?.();
      };
    },

    serve,

    fail(error) {
      serve(() => {
        throw error;
      });
    },
  };
}
