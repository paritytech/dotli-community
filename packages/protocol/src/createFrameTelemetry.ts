// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the protocol frame reports about its light client, for the network panel and telemetry tags.

import type { ChainDetail, ChainSyncEvent, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import { reportListener } from '@dotli/metrics';
import { createListenerSet, realTimers, type Timers } from '@dotli/shared';
import { createFeedKeeper, type FeedOpen } from './createFeedKeeper.js';
import type { ProtocolFrame } from './frameTypes.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';
import { subscribe } from './subscribe.js';

type Params = {
  frame: Pick<ProtocolFrame, 'getStatus' | 'subscribeStatus' | 'getTransport'>;
  /** What a reopen of the feed waits on, after the frame ended it while it stays up. */
  timers?: Timers;
};

/** What the frame reports, heard from each frame there is without booting one. */
export function createFrameTelemetry({ frame, timers = realTimers }: Params) {
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
  const reports = createFeedKeeper({ feed: 'telemetry', frame, opener: openReports, boots: false, timers });

  function openReports(transport: ProtocolTransport): FeedOpen {
    // Each frame's byte meter starts at zero, and a reopened feed reads on from the same meter.
    let lastNetBytesTotal = 0;
    return ends =>
      subscribe({
        transport,
        method: protocolSchema.sections.frame.telemetry,
        start: undefined,
        listeners: {
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
        },
      });
  }

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
    /**
     * Whether a chain began from existing smoldot state, so telemetry keeps cold syncs and warm resumes apart.
     * `unknown` until the frame there is now reports it. Never throws.
     */
    getSmoldotDbOutcome: (chain: SmoldotDbChain): SmoldotDbOutcome | 'unknown' =>
      smoldotDbOutcomes.get(chain) ?? 'unknown',
    /** Hears each chain sync event the frame reports. Does not start a frame. Returns the unsubscribe. */
    subscribeChainSync: (listener: (event: ChainSyncEvent) => void) => chainSyncListeners.subscribe(listener),
    /** Hears each chain detail the frame reports. Does not start a frame. Returns the unsubscribe. */
    subscribeChainDetail: (listener: (event: ChainDetail) => void) => chainDetailListeners.subscribe(listener),
    /**
     * Hears each received byte total the frame reports, never one below the last on the same frame. Does not start a
     * frame. Returns the unsubscribe.
     */
    subscribeNetBytes: (listener: (event: { received: number }) => void) => netBytesListeners.subscribe(listener),
  };
}
