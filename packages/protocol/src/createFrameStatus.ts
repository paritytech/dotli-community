// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether this frame can serve chains and names, as the host hears it through its `frame.status` subscription. A host
// that subscribes late hears where the frame stands at once, so nothing said before it subscribed is lost.

import { err, type MethodTypes, type Sink } from '@dotli/transport';
import { toFrameStatusEnd } from './errors.js';
import type { ProtocolContext, protocolSchema } from './schema.js';

/** How the status ends, as its subscribers hear it. */
export type FrameStatusEnd = MethodTypes<typeof protocolSchema.sections.frame.status>['interrupt'];

export type FrameStatusSink = Sink<undefined, FrameStatusEnd>;

/** The `frame.status` subscription a frame serves. */
export type FrameStatus = ReturnType<typeof createFrameStatus>;

type State = { name: 'booting' | 'ready' } | { name: 'ended'; end: FrameStatusEnd };

/**
 * A frame's status, booting until it is told ready or ended.
 *
 * @example
 * const status = createFrameStatus();
 * transport.handleSubscription(frame.status, status.handler); // then status.markReady() once the frame can serve
 */
export function createFrameStatus() {
  let state: State = { name: 'booting' };
  // A transport's sink never throws, so each host hears in turn.
  const sinks = new Set<FrameStatusSink>();

  function markReady(): void {
    if (state.name !== 'booting') {
      return;
    }
    state = { name: 'ready' };
    for (const sink of sinks) {
      sink.send(undefined);
    }
  }

  function fail(error: Error): void {
    interrupt(err(toFrameStatusEnd(error)));
  }

  function interrupt(end: FrameStatusEnd): void {
    if (state.name === 'ended') {
      return;
    }
    state = { name: 'ended', end };
    for (const sink of sinks) {
      sink.interrupt(end);
    }
    sinks.clear();
  }

  function serve(_start: undefined, _context: ProtocolContext, sink: FrameStatusSink): () => void {
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
  }

  return {
    /** The frame serves every method from now on. Does nothing once ready or ended. Never throws. */
    markReady,
    /** The frame will never serve, or has stopped for good. Only the first end is heard. Never throws. */
    fail,
    /**
     * Ends the status with `end` as it is, for a relay that passes on another frame's end. Only the first end is heard.
     */
    interrupt,
    /**
     * Serves one subscriber: it hears `ready` at once if the frame is, and the end at once if the status ended. Returns
     * its unsubscribe.
     */
    handler: serve,
  };
}
