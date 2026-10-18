// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the protocol frame reports about its light client, for the network panel and telemetry tags.

import type { ChainDetail, ChainSyncEvent, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import { log, realTimers, type Timers } from '@dotli/shared';
import { createFeedKeeper } from './feed.js';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { protocolListeners } from './listeners.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';
import { subscribe } from './subscription.js';

/** A frame that is booting or up has a transport to hear. */
function hasFrame(status: ProtocolStatus): boolean {
  return status === 'booting' || status === 'listening' || status === 'ready';
}

/** A feed the frame ends while it stays up is reopened after a wait on `timers`. */
export function createFrameTelemetry(
  frame: Pick<ProtocolFrame, 'getStatus' | 'subscribeStatus' | 'transport' | 'losses'>,
  timers: Timers = realTimers,
) {
  const chainSyncListeners = protocolListeners<ChainSyncEvent>('chain_sync');
  const chainDetailListeners = protocolListeners<ChainDetail>('chain_detail');
  const netBytesListeners = protocolListeners<{ received: number }>('net_bytes');
  // A chain stays "unknown" on the gateway path, which runs no light client, and until its store answers.
  const smoldotDbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();
  const reports = createFeedKeeper('telemetry', frame, timers);
  let heard: ProtocolTransport | null = null;

  // Each ask for a frame's transport, so an answer a later ask overtook is not heard.
  let asks = 0;

  /** Hears one frame's reports until the frame is lost. */
  function hear(transport: ProtocolTransport, since: number): void {
    if (heard === transport) {
      return;
    }
    heard = transport;
    // Each frame's byte meter starts at zero, and a reopened feed reads on from the same meter.
    let lastNetBytesTotal = 0;
    reports.hold(
      () =>
        subscribe(transport, protocolSchema.traits.frame.telemetry, undefined, event => {
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
        }),
      since,
    );
  }

  function hearFrame(): void {
    asks += 1;
    const ask = asks;
    const since = frame.losses();
    void frame.transport().then(
      transport => {
        if (ask === asks) {
          hear(transport, since);
        }
      },
      (error: unknown) => {
        log.warn('[dot.li protocol] Failed to hear the protocol frame telemetry:', error);
      },
    );
  }

  // Cleared when a new frame boots, not when one is lost, which happens before the host's pending rejection and
  // would strip the tags from the very failures they explain.
  frame.subscribeStatus(status => {
    if (status === 'booting') {
      smoldotDbOutcomes.clear();
      hearFrame();
    }
  });
  // Hearing a frame never boots one, so only a frame already there is heard at once.
  if (hasFrame(frame.getStatus())) {
    hearFrame();
  }

  return {
    /** Whether a chain began from existing smoldot state, so telemetry keeps cold syncs and warm resumes apart. */
    getSmoldotDbOutcome: (chain: SmoldotDbChain): SmoldotDbOutcome | 'unknown' =>
      smoldotDbOutcomes.get(chain) ?? 'unknown',
    onProtocolChainSync: (listener: (event: ChainSyncEvent) => void) => chainSyncListeners.subscribe(listener),
    onProtocolChainDetail: (listener: (event: ChainDetail) => void) => chainDetailListeners.subscribe(listener),
    onProtocolNetBytes: (listener: (event: { received: number }) => void) => netBytesListeners.subscribe(listener),
  };
}
