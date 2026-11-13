// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reports each chain's phase, peers and database cache, and the load's byte totals, to the network monitor and the
// debug panel. A phase's debug event only when the phase changes, since Bulletin's two taps would otherwise emit every
// block twice. Warp progress stays in `syncing`, so it passes on a slow tick.

import type { ChainRole } from '@dotli/config';
import type { ChainDetail, ChainSyncEvent } from '@dotli/chains';
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

/** The report of each chain's phase and peers, and of the load's byte totals, as its factory builds it. */
export type ChainReporter = ReturnType<typeof createChainReporter>;

/** What the reports last said of one chain. */
type Reported = {
  peers: number | null;
  /** The phase its last phase event carried. */
  phase: ChainPhase | null;
  /** The warp block its last phase event carried, and when that event went out. */
  warpAt: number | null;
  warpEmittedAt: number;
};

/** Builds the report of each chain's phase and peers, and of the load's byte totals. */
export function createChainReporter({ flowId, timers, debugBus }: Params) {
  const reported = new Map<ChainRole, Reported>();
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
    /** Reports the chain's database cache, when `detail` names it. Never throws. */
    recordDetail(detail: ChainDetail): void {
      if (detail.dbCache === undefined) {
        return;
      }
      debugBus.emit({
        layer: 'chain',
        event: 'dbcache',
        flowId,
        timestamp: timers.now(),
        payload: { chain: detail.chain, dbCache: detail.dbCache },
      });
    },
    /** Reports `received`, the load's byte total so far. Never throws. */
    recordBytes(received: number): void {
      debugBus.emit({ layer: 'chain', event: 'bytes', flowId, timestamp: timers.now(), payload: { received } });
    },
  };

  function getReported(role: ChainRole): Reported {
    let chain = reported.get(role);
    if (chain === undefined) {
      chain = { peers: null, phase: null, warpAt: null, warpEmittedAt: 0 };
      reported.set(role, chain);
    }
    return chain;
  }

  function recordPeers(role: ChainRole, peers: number): void {
    // Independent of the phase, since the relay usually finds its peers after its last transition.
    const chain = getReported(role);
    const changed = chain.peers !== peers;
    chain.peers = peers;
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
    const chain = getReported(role);
    const now = timers.now();
    const warpMoved =
      phase === 'syncing' &&
      event.at !== undefined &&
      chain.warpAt !== event.at &&
      now - chain.warpEmittedAt >= CHAIN_WARP_DEBUG_MS;
    const phaseChanged = chain.phase !== phase;
    if (!phaseChanged && !warpMoved) {
      return;
    }
    chain.phase = phase;
    if (event.at !== undefined) {
      chain.warpAt = event.at;
      chain.warpEmittedAt = now;
    }
    const { peers } = chain;
    if (phaseChanged) {
      report.log.event(`${getChainTelemetryName(event.chain)} ${phase}`, {
        ...(peers === null ? {} : { peers }),
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
        ...(peers === null ? {} : { peers }),
        ...(event.at === undefined ? {} : { warpAt: event.at }),
        ...(event.target === undefined ? {} : { warpTarget: event.target }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      },
    });
  }
}
