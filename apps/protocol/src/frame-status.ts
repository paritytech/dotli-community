// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether this frame can serve chains and names, as the host hears it through its `frameStatus` subscription. A host
// that subscribes late hears where the frame stands at once, so nothing said before it subscribed is lost.

import { reportListener } from '@dotli/metrics';
import type { SubscriptionHandler, SubscriptionSink } from '@dotli/protocol';

type State = { name: 'booting' | 'ready' } | { name: 'failed'; error: Error };

export interface FrameStatus {
  /** The frame serves every method from now on. Does nothing once ready or failed. */
  ready(): void;
  /** The frame will never serve, or has stopped for good. Only the first failure is heard. */
  fail(error: Error): void;
  handler: SubscriptionHandler<'frameStatus'>;
}

/** `report` hears a sink that throws, so each other host still hears the frame. Captured by default. */
export function createFrameStatus(
  report: (error: unknown) => void = reportListener('protocol', 'protocol.frame_status'),
): FrameStatus {
  let state: State = { name: 'booting' };
  const sinks = new Set<SubscriptionSink<'frameStatus'>>();

  const tell = (
    sinksToTell: SubscriptionSink<'frameStatus'>[],
    say: (sink: SubscriptionSink<'frameStatus'>) => void,
  ) => {
    for (const sink of sinksToTell) {
      try {
        say(sink);
      } catch (error) {
        report(error);
      }
    }
  };

  return {
    ready() {
      if (state.name !== 'booting') {
        return;
      }
      state = { name: 'ready' };
      tell([...sinks], sink => {
        sink.send(undefined);
      });
    },

    fail(error) {
      if (state.name === 'failed') {
        return;
      }
      state = { name: 'failed', error };
      const ending = [...sinks];
      sinks.clear();
      tell(ending, sink => {
        sink.end(error);
      });
    },

    handler: (_payload, _context, sink) => {
      if (state.name === 'failed') {
        sink.end(state.error);
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
