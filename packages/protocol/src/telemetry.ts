// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the protocol frame reports about its light client, for the network panel and telemetry tags.

import type { ProtocolFrame } from './frame.js';
import { protocolListeners } from './listeners.js';
import {
  envelopeChainRole,
  isChainDetailPayloadValid,
  isChainSyncPayloadValid,
  type ProtocolChainDetailEnvelope,
  type ProtocolChainSyncEnvelope,
  type ProtocolNetBytesEnvelope,
  type SmoldotDbChain,
  type SmoldotDbOutcome,
} from './messages.js';

export function createFrameTelemetry(frame: Pick<ProtocolFrame, 'subscribeStatus' | 'onEnvelope' | 'onLost'>) {
  const chainSyncListeners = protocolListeners<ProtocolChainSyncEnvelope>('chain_sync');
  const chainDetailListeners = protocolListeners<ProtocolChainDetailEnvelope>('chain_detail');
  const netBytesListeners = protocolListeners<ProtocolNetBytesEnvelope>('net_bytes');
  let lastNetBytesTotal = 0;
  // A chain stays "unknown" on the gateway path, which runs no light client, and until its store answers.
  const smoldotDbOutcomes = new Map<SmoldotDbChain, SmoldotDbOutcome>();

  // Cleared when a new frame boots, not when one is lost, which happens before the host's pending rejection and
  // would strip the tags from the very failures they explain.
  frame.subscribeStatus(status => {
    if (status === 'booting') {
      smoldotDbOutcomes.clear();
    }
  });

  // The rebuilt frame's byte meter restarts at zero, and the monotonic gate would drop its reports.
  frame.onLost(() => {
    lastNetBytesTotal = 0;
  });

  frame.onEnvelope(msg => {
    if (msg.kind === 'chain-sync') {
      const chain = envelopeChainRole(msg.chain);
      if (chain !== null && isChainSyncPayloadValid(msg)) {
        chainSyncListeners.emit({ ...msg, chain });
      }
    } else if (msg.kind === 'chain-detail') {
      const chain = envelopeChainRole(msg.chain);
      if (chain !== null && isChainDetailPayloadValid(msg)) {
        chainDetailListeners.emit({ ...msg, chain });
      }
    } else if (msg.kind === 'net-bytes') {
      // Cumulative, so a total below the last one is spoofed or corrupt
      // traffic and would feed a negative rate into the network panel.
      if (Number.isFinite(msg.received) && msg.received >= lastNetBytesTotal) {
        lastNetBytesTotal = msg.received;
        netBytesListeners.emit(msg);
      }
    } else if (msg.kind === 'smoldot-db') {
      // These become Sentry tags and the envelope check covers only namespace and kind, so a buggy
      // frame could otherwise write unbounded tag values.
      const chain = envelopeChainRole(msg.chain);
      const outcome: string = msg.outcome;
      if (
        chain !== null &&
        chain !== 'people' &&
        (outcome === 'hit' || outcome === 'miss' || outcome === 'unavailable')
      ) {
        smoldotDbOutcomes.set(chain, outcome);
      }
    }
  });

  return {
    /** Whether a chain began from existing smoldot state, so telemetry keeps cold syncs and warm resumes apart. */
    getSmoldotDbOutcome: (chain: SmoldotDbChain): SmoldotDbOutcome | 'unknown' =>
      smoldotDbOutcomes.get(chain) ?? 'unknown',
    /** Events arrive only after the origin- and source-gated listener validates them. */
    onProtocolChainSync: (listener: (event: ProtocolChainSyncEnvelope) => void) =>
      chainSyncListeners.subscribe(listener),
    onProtocolChainDetail: (listener: (event: ProtocolChainDetailEnvelope) => void) =>
      chainDetailListeners.subscribe(listener),
    onProtocolNetBytes: (listener: (event: ProtocolNetBytesEnvelope) => void) => netBytesListeners.subscribe(listener),
  };
}
