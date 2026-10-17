// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the protocol frame reports about its light client, for the network panel and telemetry tags.

import type { ChainDetail, ChainSyncEvent, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import { log } from '@dotli/shared';
import type { ProtocolFrame, ProtocolStatus } from './frame.js';
import { protocolListeners } from './listeners.js';
import type { ConsumerTransport } from './transport.js';

/** A frame that is booting or up has a transport to hear. */
function hasFrame(status: ProtocolStatus): boolean {
  return status === 'booting' || status === 'listening' || status === 'ready';
}

export function createFrameTelemetry(frame: Pick<ProtocolFrame, 'getStatus' | 'subscribeStatus' | 'transport'>) {
  const chainSyncListeners = protocolListeners<ChainSyncEvent>('chain_sync');
  const chainDetailListeners = protocolListeners<ChainDetail>('chain_detail');
  const netBytesListeners = protocolListeners<{ received: number }>('net_bytes');
  // A chain stays "unknown" on the gateway path, which runs no light client, and until its store answers.
  const smoldotDbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();
  let heard: ConsumerTransport | null = null;

  /** Hears one frame's reports, which end with it. */
  function hear(transport: ConsumerTransport): void {
    if (heard === transport) {
      return;
    }
    heard = transport;
    // Each frame's byte meter starts at zero.
    let lastNetBytesTotal = 0;
    transport.subscribe('telemetry', undefined, event => {
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
    });
  }

  function hearFrame(): void {
    void frame.transport().then(hear, (error: unknown) => {
      log.warn('[dot.li protocol] Failed to hear the protocol frame telemetry:', error);
    });
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
