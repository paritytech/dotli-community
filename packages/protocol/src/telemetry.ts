// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the protocol frame reports about its light client, for the network panel and telemetry tags.

import type { ProtocolFrame } from './frame.js';
import { addListener, broadcast } from './listeners.js';
import {
  isChainDetailPayloadValid,
  isChainSyncPayloadValid,
  type ProtocolChainDetailEnvelope,
  type ProtocolChainSyncEnvelope,
  type ProtocolNetBytesEnvelope,
  type SmoldotDbChain,
  type SmoldotDbOutcome,
} from './messages.js';

export interface FrameTelemetry {
  /** Whether a chain began from existing smoldot state, so telemetry keeps cold syncs and warm resumes apart. */
  getSmoldotDbOutcome(chain: SmoldotDbChain): SmoldotDbOutcome | 'unknown';
  /** Events arrive only after the origin- and source-gated listener validates them. */
  onProtocolChainSync(listener: (event: ProtocolChainSyncEnvelope) => void): () => void;
  onProtocolChainDetail(listener: (event: ProtocolChainDetailEnvelope) => void): () => void;
  onProtocolNetBytes(listener: (event: ProtocolNetBytesEnvelope) => void): () => void;
}

export function createFrameTelemetry(
  frame: Pick<ProtocolFrame, 'subscribeStatus' | 'onEnvelope' | 'onLost'>,
): FrameTelemetry {
  const chainSyncListeners = new Set<(event: ProtocolChainSyncEnvelope) => void>();
  const chainDetailListeners = new Set<(event: ProtocolChainDetailEnvelope) => void>();
  const netBytesListeners = new Set<(event: ProtocolNetBytesEnvelope) => void>();
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
      if (isChainSyncPayloadValid(msg)) {
        broadcast(chainSyncListeners, msg, 'Chain sync');
      }
    } else if (msg.kind === 'chain-detail') {
      if (isChainDetailPayloadValid(msg)) {
        broadcast(chainDetailListeners, msg, 'Chain detail');
      }
    } else if (msg.kind === 'net-bytes') {
      // Cumulative, so a total below the last one is spoofed or corrupt
      // traffic and would feed a negative rate into the network panel.
      if (Number.isFinite(msg.received) && msg.received >= lastNetBytesTotal) {
        lastNetBytesTotal = msg.received;
        broadcast(netBytesListeners, msg, 'Net bytes');
      }
    } else if (msg.kind === 'smoldot-db') {
      // These become Sentry tags and the envelope check covers only namespace and kind, so a buggy
      // frame could otherwise write unbounded tag values.
      const chain: string = msg.chain;
      const outcome: string = msg.outcome;
      if (
        (chain === 'relay' || chain === 'hub' || chain === 'bulletin') &&
        (outcome === 'hit' || outcome === 'miss' || outcome === 'unavailable')
      ) {
        smoldotDbOutcomes.set(chain, outcome);
      }
    }
  });

  return {
    getSmoldotDbOutcome: chain => smoldotDbOutcomes.get(chain) ?? 'unknown',
    onProtocolChainSync: listener => addListener(chainSyncListeners, listener),
    onProtocolChainDetail: listener => addListener(chainDetailListeners, listener),
    onProtocolNetBytes: listener => addListener(netBytesListeners, listener),
  };
}
