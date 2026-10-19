// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the protocol frame reports about its light client, for the network panel and telemetry tags.

import type { ChainDetail, ChainSyncEvent, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import { reportListener } from '@dotli/metrics';
import { createListenerSet, realTimers, type Timers } from '@dotli/shared';
import { createFeedKeeper } from './feed.js';
import type { ProtocolFrame } from './frame.js';
import { protocolSchema } from './schema.js';
import { subscribe } from './subscription.js';

/** A feed the frame ends while it stays up is reopened after a wait on `timers`. */
export function createFrameTelemetry(
  frame: Pick<ProtocolFrame, 'getStatus' | 'subscribeStatus' | 'transport'>,
  timers: Timers = realTimers,
) {
  const chainSyncListeners = createListenerSet<ChainSyncEvent>({
    onListenerError: reportListener('protocol', 'protocol.chain_sync'),
  });
  const chainDetailListeners = createListenerSet<ChainDetail>({
    onListenerError: reportListener('protocol', 'protocol.chain_detail'),
  });
  const netBytesListeners = createListenerSet<{ received: number }>({
    onListenerError: reportListener('protocol', 'protocol.net_bytes'),
  });
  // A chain stays "unknown" on the gateway path, which runs no light client, and until its store answers.
  const smoldotDbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();
  const reports = createFeedKeeper(
    'telemetry',
    frame,
    transport => {
      // Each frame's byte meter starts at zero, and a reopened feed reads on from the same meter.
      let lastNetBytesTotal = 0;
      return ends =>
        subscribe(transport, protocolSchema.traits.frame.telemetry, undefined, {
          receive: event => {
            switch (event.tag) {
              case 'chainSync':
                chainSyncListeners.emit(event.value);
                return;
              case 'chainDetail':
                chainDetailListeners.emit(event.value);
                return;
              case 'netBytes':
                // Cumulative, so a total below the last one is corrupt traffic and would feed a negative rate into the
                // network panel.
                if (event.value >= lastNetBytesTotal) {
                  lastNetBytesTotal = event.value;
                  netBytesListeners.emit({ received: event.value });
                }
                return;
              case 'smoldotDb':
                smoldotDbOutcomes.set(event.value.chain, event.value.outcome);
                return;
            }
          },
          ...ends,
        });
    },
    { boots: false, timers },
  );

  // Cleared when a new frame boots, not when one is lost, which happens before the host's pending rejection and
  // would strip the tags from the very failures they explain.
  frame.subscribeStatus(status => {
    if (status === 'booting') {
      smoldotDbOutcomes.clear();
    }
  });
  // Hearing a frame never boots one, so the reports are heard from each frame there is.
  reports.follow();

  return {
    /** Whether a chain began from existing smoldot state, so telemetry keeps cold syncs and warm resumes apart. */
    getSmoldotDbOutcome: (chain: SmoldotDbChain): SmoldotDbOutcome | 'unknown' =>
      smoldotDbOutcomes.get(chain) ?? 'unknown',
    onProtocolChainSync: (listener: (event: ChainSyncEvent) => void) => chainSyncListeners.subscribe(listener),
    onProtocolChainDetail: (listener: (event: ChainDetail) => void) => chainDetailListeners.subscribe(listener),
    onProtocolNetBytes: (listener: (event: { received: number }) => void) => netBytesListeners.subscribe(listener),
  };
}
