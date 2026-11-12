// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reports each chain's phase and peers to the network monitor and the debug panel. A debug event only when the phase
// changes, since Bulletin's two taps would otherwise emit every block twice. Warp progress stays in `syncing`, so it
// passes on a slow tick.

import type { ChainRole } from '@dotli/config';
import type { ChainSyncEvent } from '@dotli/chains';
import { createReporter } from '@dotli/metrics';
import type { Timers } from '@dotli/shared';
import type { DebugBus } from '@dotli/truapi-debug';
import { createChainPhaseTracker } from './createChainPhaseTracker.js';
import { getChainTelemetryName } from './getChainTelemetryName.js';
import { networkMonitorState, type ChainPhase } from './state/networkMonitorState.js';

type Params = {
  /** The debug panel's flow for this page load. */
  flowId: string;
  /** The clock the debug events are stamped with. */
  timers: Pick<Timers, 'now'>;
  /** Where the chain events go. */
  debugBus: DebugBus;
};

// Sampled rather than emitted per step, or a long warp crowds the debug panel's ring buffer.
const CHAIN_WARP_DEBUG_MS = 1000;

const report = createReporter({ flow: 'chain' });

/** Builds the report of each chain's phase and peers. */
export function createChainReporter({ flowId, timers, debugBus }: Params) {
  const emittedPhase = new Map<ChainRole, ChainPhase>();
  const emittedWarpAt = new Map<ChainRole, number>();
  const lastWarpEmit = new Map<ChainRole, number>();
  const peersByRole = new Map<ChainRole, number>();
  const trackPhase = createChainPhaseTracker();

  return {
    /** Reports the phase `event` leaves its chain in, and its peer count. Never throws. */
    record(event: ChainSyncEvent): void {
      const phase = trackPhase(event.chain, event.kind);
      if (event.kind === 'peers' && event.peers !== undefined) {
        recordPeers(event.chain, event.peers);
      }
      if (phase !== undefined) {
        recordPhase(event, phase);
      }
    },
  };

  function recordPeers(role: ChainRole, peers: number): void {
    // Independent of the phase, since the relay usually finds its peers after its last transition.
    const changed = peersByRole.get(role) !== peers;
    peersByRole.set(role, peers);
    if (changed) {
      debugBus.emit({
        layer: 'chain',
        event: 'peers',
        flowId,
        timestamp: timers.now(),
        payload: { chain: role, peers },
      });
    }
    // Every chain, including those the loading screen has no stall wording for.
    networkMonitorState.recordPeerCount(role, peers);
  }

  function recordPhase(event: ChainSyncEvent, phase: ChainPhase): void {
    const role = event.chain;
    networkMonitorState.recordChainPhase(role, phase);
    const now = timers.now();
    const warpMoved =
      phase === 'syncing' &&
      event.at !== undefined &&
      emittedWarpAt.get(role) !== event.at &&
      now - (lastWarpEmit.get(role) ?? 0) >= CHAIN_WARP_DEBUG_MS;
    const phaseChanged = emittedPhase.get(role) !== phase;
    if (!phaseChanged && !warpMoved) {
      return;
    }
    emittedPhase.set(role, phase);
    if (event.at !== undefined) {
      emittedWarpAt.set(role, event.at);
      lastWarpEmit.set(role, now);
    }
    const peers = peersByRole.get(role);
    if (phaseChanged) {
      report.log.event(`${getChainTelemetryName(event.chain)} ${phase}`, {
        ...(peers === undefined ? {} : { peers }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
    }
    debugBus.emit({
      layer: 'chain',
      event: 'phase',
      flowId,
      timestamp: now,
      payload: {
        chain: role,
        phase,
        ...(peers === undefined ? {} : { peers }),
        ...(event.at === undefined ? {} : { warpAt: event.at }),
        ...(event.target === undefined ? {} : { warpTarget: event.target }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      },
    });
  }
}
