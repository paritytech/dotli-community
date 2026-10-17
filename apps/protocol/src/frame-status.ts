// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether this frame can serve chains and names, as the host hears it through its `frameStatus` subscription. A host
// that subscribes late hears where the frame stands at once, so nothing said before it subscribed is lost.

import type { SubscriptionHandler, SubscriptionSink } from '@dotli/protocol';

type State = { name: 'booting' | 'ready' } | { name: 'failed'; error: Error };

export interface FrameStatus {
  /** The frame serves every method from now on. Does nothing once ready or failed. */
  ready(): void;
  /** The frame will never serve, or has stopped for good. Only the first failure is heard. */
  fail(error: Error): void;
  handler: SubscriptionHandler<'frameStatus'>;
}

export function createFrameStatus(): FrameStatus {
  let state: State = { name: 'booting' };
  const sinks = new Set<SubscriptionSink<'frameStatus'>>();

  return {
    ready() {
      if (state.name !== 'booting') {
        return;
      }
      state = { name: 'ready' };
      for (const sink of [...sinks]) {
        sink.send(undefined);
      }
    },

    fail(error) {
      if (state.name === 'failed') {
        return;
      }
      state = { name: 'failed', error };
      const ending = [...sinks];
      sinks.clear();
      for (const sink of ending) {
        sink.end(error);
      }
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
