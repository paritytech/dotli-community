// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether this frame can serve chains and names, as the host hears it through its `frame.status` subscription. A host
// that subscribes late hears where the frame stands at once, so nothing said before it subscribed is lost.

import { err, type MethodTypes, type Sink } from '@dotli/transport';
import { frameStatusEnd } from './errors.js';
import type { ProtocolHandler, protocolSchema } from './schema.js';

/** How the status ends, as its subscribers hear it. */
export type FrameStatusEnd = MethodTypes<typeof protocolSchema.sections.frame.status>['interrupt'];

export type FrameStatusSink = Sink<undefined, FrameStatusEnd>;

type State = { name: 'booting' | 'ready' } | { name: 'ended'; end: FrameStatusEnd };

export interface FrameStatus {
  /** The frame serves every method from now on. Does nothing once ready or ended. */
  ready(): void;
  /** The frame will never serve, or has stopped for good. Only the first end is heard. */
  fail(error: Error): void;
  /** Ends the status with `end` as it is, for a relay that passes on another frame's end. Only the first end is heard. */
  interrupt(end: FrameStatusEnd): void;
  handler: ProtocolHandler<typeof protocolSchema.sections.frame.status>;
}

export function createFrameStatus(): FrameStatus {
  let state: State = { name: 'booting' };
  // A transport's sink never throws, so each host hears in turn.
  const sinks = new Set<FrameStatusSink>();

  const interrupt = (end: FrameStatusEnd): void => {
    if (state.name === 'ended') {
      return;
    }
    state = { name: 'ended', end };
    for (const sink of sinks) {
      sink.interrupt(end);
    }
    sinks.clear();
  };

  return {
    ready() {
      if (state.name !== 'booting') {
        return;
      }
      state = { name: 'ready' };
      for (const sink of sinks) {
        sink.send(undefined);
      }
    },

    fail(error) {
      interrupt(err(frameStatusEnd(error)));
    },

    interrupt,

    handler: (_start, _context, sink) => {
      if (state.name === 'ended') {
        sink.interrupt(state.end);
        return () => undefined;
      }
      if (state.name === 'ready') {
        sink.send(undefined);
      }
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
  };
}
