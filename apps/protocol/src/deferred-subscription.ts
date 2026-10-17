// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A subscription the frame accepts before what feeds it has loaded. The host subscribes as soon as the handshake is
// answered, and a refusal then would never be retried on that frame.

import type {
  CallContext,
  SubscribePayload,
  SubscriptionHandler,
  SubscriptionMethod,
  SubscriptionSink,
} from '@dotli/protocol';
import { toError } from '@dotli/shared';

interface Waiting<M extends SubscriptionMethod> {
  payload: SubscribePayload<M>;
  context: CallContext;
  sink: SubscriptionSink<M>;
  /** Null until the real handler starts it. */
  stop: (() => void) | null;
  /** Stopped by an unsubscribe, an end or a dispose, which may come while the real handler runs. */
  stopped: boolean;
}

export interface DeferredSubscription<M extends SubscriptionMethod> {
  /** Registered at once. Each subscription waits until `serve`, and one that stops first never starts. */
  handler: SubscriptionHandler<M>;
  /** Starts every waiting subscription on `real`, and every later one at once. Only the first `serve` or `fail` counts. */
  serve(real: SubscriptionHandler<M>): void;
  /** Ends every waiting subscription with `error`, and every later one at once, for a source that will never come. */
  fail(error: Error): void;
}

export function createDeferredSubscription<M extends SubscriptionMethod>(): DeferredSubscription<M> {
  let real: SubscriptionHandler<M> | null = null;
  const waiting = new Set<Waiting<M>>();

  const start = (entry: Waiting<M>, handler: SubscriptionHandler<M>): void => {
    const stop = handler(entry.payload, entry.context, entry.sink);
    if (entry.stopped) {
      stop();
    } else {
      entry.stop = stop;
    }
  };

  const serve = (handler: SubscriptionHandler<M>): void => {
    if (real !== null) {
      return;
    }
    real = handler;
    const started = [...waiting];
    waiting.clear();
    for (const entry of started) {
      try {
        start(entry, handler);
      } catch (error) {
        // A handler that throws refuses that subscription, as the transport does with one it runs itself.
        entry.sink.end(toError(error));
      }
    }
  };

  return {
    handler: (payload, context, sink) => {
      const entry: Waiting<M> = { payload, context, sink, stop: null, stopped: false };
      if (real === null) {
        waiting.add(entry);
      } else {
        start(entry, real);
      }
      return () => {
        entry.stopped = true;
        waiting.delete(entry);
        entry.stop?.();
      };
    },

    serve,

    fail(error) {
      serve((_payload, _context, sink) => {
        sink.end(error);
        return () => undefined;
      });
    },
  };
}
