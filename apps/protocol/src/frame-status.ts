// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether this frame can serve chains and names, as the host hears it through its `frame.status` subscription. A host
// that subscribes late hears where the frame stands at once, so nothing said before it subscribed is lost.

import { reportListener } from '@dotli/metrics';
import {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  type ProtocolSchema,
} from '@dotli/protocol';
import {
  domain,
  hostFailure,
  type CallError,
  type DomainError,
  type Sink,
  type SubscriptionHandler,
} from '@dotli/transport';

/** Why the frame's status ended, typed so the host tells a crash, a failed boot and a released port apart. */
export type FrameFailure = DomainError<ProtocolSchema, 'frame', 'status'>;

export type FrameStatusSink = Sink<void, FrameFailure>;

/** How the frame status ends on `error`: typed for a fatal, a failed init or a released port, else as its failure. */
export function frameStatusEnd(error: Error): CallError<FrameFailure> {
  if (error instanceof ProtocolFatalError) {
    return domain({ tag: 'fatal', value: error.message });
  }
  if (error instanceof ProtocolInitFailedError) {
    return domain({ tag: 'initFailed', value: error.message });
  }
  if (error instanceof ProtocolPortReleasedError) {
    return domain({ tag: 'released', value: error.message });
  }
  return hostFailure(error);
}

/** Where the status stands. An end of undefined is a clean one. */
type State = { name: 'booting' | 'ready' } | { name: 'ended'; end: CallError<FrameFailure> | undefined };

export interface FrameStatus {
  /** The frame serves every method from now on. Does nothing once ready or ended. */
  ready(): void;
  /** The frame will never serve, or has stopped for good. Only the first end is heard. */
  fail(error: Error): void;
  /**
   * Ends the status with `end` as it is, or cleanly with none, for a relay that passes on another frame's end. Only the
   * first end is heard.
   */
  interrupt(end?: CallError<FrameFailure>): void;
  handler: SubscriptionHandler<ProtocolSchema, 'frame', 'status'>;
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

  const interrupt = (end?: CallError<FrameFailure>): void => {
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
      interrupt(frameStatusEnd(error));
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
