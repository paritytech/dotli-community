// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether this frame can serve chains and names, as the host hears it through its `frame.status` subscription. A host
// that subscribes late hears where the frame stands at once, so nothing said before it subscribed is lost.

import { reportListener } from '@dotli/metrics';
import { err, type MethodTypes, type Sink } from '@dotli/transport';
import { frameStatusEnd } from './outcomes.js';
import type { FrameFailure, ProtocolHandler, protocolSchema } from './schema.js';

export type FrameStatusSink = Sink<undefined, FrameFailure>;

/** How the status ends, as its subscribers hear it. */
export type FrameStatusEnd = MethodTypes<typeof protocolSchema.traits.frame.status>['interrupt'];

type State = { name: 'booting' | 'ready' } | { name: 'ended'; end: FrameStatusEnd };

export interface FrameStatus {
  /** The frame serves every method from now on. Does nothing once ready or ended. */
  ready(): void;
  /** The frame will never serve, or has stopped for good. Only the first end is heard. */
  fail(error: Error): void;
  /** Ends the status with `end` as it is, for a relay that passes on another frame's end. Only the first end is heard. */
  interrupt(end: FrameStatusEnd): void;
  handler: ProtocolHandler<typeof protocolSchema.traits.frame.status>;
}

/** `report` hears a sink that throws, so each other host still hears the frame. Captured by default. */
export function createFrameStatus(
  report: (error: unknown) => void = reportListener('protocol', 'protocol.frame_status'),
): FrameStatus {
  let state: State = { name: 'booting' };
  const sinks = new Set<FrameStatusSink>();

  const tell = (sinksToTell: FrameStatusSink[], say: (sink: FrameStatusSink) => void) => {
    for (const sink of sinksToTell) {
      try {
        say(sink);
      } catch (error) {
        report(error);
      }
    }
  };

  const interrupt = (end: FrameStatusEnd): void => {
    if (state.name === 'ended') {
      return;
    }
    state = { name: 'ended', end };
    const ending = [...sinks];
    sinks.clear();
    tell(ending, sink => {
      sink.interrupt(end);
    });
  };

  return {
    ready() {
      if (state.name !== 'booting') {
        return;
      }
      state = { name: 'ready' };
      tell([...sinks], sink => {
        sink.receive(undefined);
      });
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
        sink.receive(undefined);
      }
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
  };
}
