// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A fake server of a subscription, for tests of a client's start, values and stop.

import type { ResultPayload } from 'scale-ts';
import type { Sink } from '../createServedCalls.js';
import type { Transport } from '../createTransport.js';
import { notes } from './testSchema.js';

/** Serves `notes.watch` on a transport, keeping each subscription's start and sink and counting its stops. */
export function serveWatch(transport: Transport<string>) {
  const starts: string[] = [];
  const sinks: Sink<string, ResultPayload<undefined, string>>[] = [];
  const stops: number[] = [];
  transport.handleSubscription(notes.watch, (start, _context, sink) => {
    const index = sinks.length;
    starts.push(start);
    sinks.push(sink);
    stops.push(0);
    return () => {
      stops[index] = (stops[index] ?? 0) + 1;
    };
  });
  return { starts, sinks, stops };
}
