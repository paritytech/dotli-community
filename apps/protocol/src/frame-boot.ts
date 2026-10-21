// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the host hears of this frame's boot: whether it serves, and the telemetry its chain mode feeds. The host
// subscribes to both as soon as its handshake is answered, before the mode has loaded anything, and a subscription
// left waiting would never end. So the frame accepts a subscription before what feeds it has loaded, since a refusal
// then would never be retried on that frame.

import {
  createFrameStatus,
  type FrameStatusEnd,
  type ProtocolContext,
  type ProtocolHandler,
  type ProtocolHello,
  type protocolSchema,
  type SubscriptionEnd,
  type TelemetryEvent,
} from '@dotli/protocol';
import { toError } from '@dotli/shared';
import { err, hostFailure, type Sink, type SubscriptionHandler } from '@dotli/transport';

type Handler<St, V, E> = SubscriptionHandler<St, V, SubscriptionEnd<E>, ProtocolHello>;

interface Waiting<St, V, E> {
  start: St;
  context: ProtocolContext;
  sink: Sink<V, SubscriptionEnd<E>>;
  /** Null until the real handler starts it. */
  stop: (() => void) | null;
  /** Stopped by the peer, an interrupt or a dispose, which may come while the real handler runs. */
  stopped: boolean;
}

export interface DeferredSubscription<St, V, E> {
  /** Registered at once. Each subscription waits until `serve`, and one that stops first never starts. */
  handler: Handler<St, V, E>;
  /** Starts every waiting subscription on `real`, and every later one at once. Only the first `serve` or `fail` counts. */
  serve(real: Handler<St, V, E>): void;
  /** Ends every waiting subscription with `error`, and every later one at once, for a source that will never come. */
  fail(error: Error): void;
}

export function createDeferredSubscription<St, V, E>(): DeferredSubscription<St, V, E> {
  let real: Handler<St, V, E> | null = null;
  const waiting = new Set<Waiting<St, V, E>>();

  const run = (entry: Waiting<St, V, E>, handler: Handler<St, V, E>): void => {
    const stop = handler(entry.start, entry.context, entry.sink);
    if (entry.stopped) {
      stop();
    } else {
      entry.stop = stop;
    }
  };

  const serve = (handler: Handler<St, V, E>): void => {
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
      const entry: Waiting<St, V, E> = { start, context, sink, stop: null, stopped: false };
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

type Telemetry = ProtocolHandler<typeof protocolSchema.sections.frame.telemetry>;

export interface FrameBoot {
  frameStatus: ProtocolHandler<typeof protocolSchema.sections.frame.status>;
  telemetry: Telemetry;
  /** Feeds the telemetry from the mode's light client. Only the first source, or the idle feed of `ready`, counts. */
  serveTelemetry(source: Telemetry): void;
  /** The frame serves from now on. A mode that runs no light client of its own has served none, so it reports nothing. */
  ready(): void;
  /** The frame will never serve, or has stopped for good. A telemetry subscription still waiting ends with `error`. */
  fail(error: Error): void;
  /**
   * Ends the status with another frame's end as it is, for the relay. The relay serves the telemetry before it can hear
   * an end, so none waits.
   */
  interrupt(end: FrameStatusEnd): void;
}

const idleTelemetry: Telemetry = () => () => undefined;

export function createFrameBoot(): FrameBoot {
  const status = createFrameStatus();
  const telemetry = createDeferredSubscription<undefined, TelemetryEvent, undefined>();
  return {
    frameStatus: status.handler,
    telemetry: telemetry.handler,
    serveTelemetry(source) {
      telemetry.serve(source);
    },
    ready() {
      telemetry.serve(idleTelemetry);
      status.ready();
    },
    fail(error) {
      status.fail(error);
      telemetry.fail(error);
    },
    interrupt(end) {
      status.interrupt(end);
    },
  };
}
