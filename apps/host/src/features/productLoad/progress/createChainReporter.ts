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
import { networkMonitorState, type ChainPhase, type NetworkMonitor } from '../../network/index.js';

type Params = {
  /** The debug panel's flow for this page load. */
  flowId: string;
  /** The clock the debug events are stamped with. */
  timers: Pick<Timers, 'now'>;
  /** Where the chain events go. */
  debugBus: DebugBus;
  /** The network monitor each chain's phase and peers feed, the page's own by default. */
  monitor?: Pick<NetworkMonitor, 'recordPeerCount' | 'recordChainPhase'>;
};

// Sampled rather than emitted per step, or a long warp crowds the debug panel's ring buffer.
const CHAIN_WARP_DEBUG_MS = 1000;
// Every other 500ms byte total, which still resolves the peak.
const CHAIN_BYTES_DEBUG_MS = 1000;
/** For a load that never hands off. */
const CHAIN_BYTES_DEBUG_MAX = 300;

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

/**
 * The sampled report of the load's byte totals, with `latest` the last total heard. It closes once the load hands off,
 * or it pushes the load's own events out of the debug panel's ring buffer.
 */
type ByteTotals =
  { kind: 'open'; sampled: { at: number; total: number } | null; samples: number; latest: number } | { kind: 'closed' };

/** Builds the report of each chain's phase and peers, and of the load's byte totals. */
export function createChainReporter({ flowId, timers, debugBus, monitor = networkMonitorState }: Params) {
  const reported = new Map<ChainRole, Reported>();
  const trackPhase = createChainPhaseTracker();
  let byteTotals: ByteTotals = { kind: 'open', sampled: null, samples: 0, latest: 0 };

  return {
    /** Reports the phase `event` leaves its chain in, and its peer count. */
    record(event: ChainSyncEvent): void {
      const phase = trackPhase(event.chain, event.kind);
      if (event.kind === 'peers' && event.peers !== undefined) {
        recordPeers(event.chain, event.peers);
      }
      if (phase !== undefined) {
        recordPhase(event, phase);
      }
    },
    /** Reports the chain's database cache, when `detail` names it. */
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
    /**
     * Reports `received`, the load's byte total so far, when it is new a second after the last total reported, up to a
     * cap. The load starts at zero bytes, so a zero total before any report is not new. Nothing once the totals closed.
     */
    recordBytes(received: number): void {
      if (byteTotals.kind === 'closed') {
        return;
      }
      const { sampled, samples } = byteTotals;
      const now = timers.now();
      const due =
        samples < CHAIN_BYTES_DEBUG_MAX &&
        received !== (sampled?.total ?? 0) &&
        (sampled === null || now - sampled.at >= CHAIN_BYTES_DEBUG_MS);
      if (!due) {
        byteTotals = { ...byteTotals, latest: received };
        return;
      }
      byteTotals = { kind: 'open', sampled: { at: now, total: received }, samples: samples + 1, latest: received };
      emitBytes(received);
    },
    /**
     * Ends the byte totals, once the load hands off, with the last total heard when it was not reported. A load that
     * reported none leaves nothing out. Safe to repeat.
     */
    closeBytes(): void {
      if (byteTotals.kind === 'closed') {
        return;
      }
      const { sampled, latest } = byteTotals;
      byteTotals = { kind: 'closed' };
      if (sampled !== null && latest !== sampled.total) {
        emitBytes(latest);
      }
    },
  };

  function emitBytes(received: number): void {
    debugBus.emit({ layer: 'chain', event: 'bytes', flowId, timestamp: timers.now(), payload: { received } });
  }

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
    monitor.recordPeerCount(role, peers);
  }

  function recordPhase(event: ChainSyncEvent, phase: ChainPhase): void {
    const role = event.chain;
    monitor.recordChainPhase(role, phase);
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
    const peersField = chain.peers === null ? {} : { peers: chain.peers };
    const reasonField = event.reason === undefined ? {} : { reason: event.reason };
    if (phaseChanged) {
      report.log.event(`${getChainTelemetryName(role)} ${phase}`, { ...peersField, ...reasonField });
    }
    debugBus.emit({
      layer: 'chain',
      event: 'phase',
      flowId,
      timestamp: now,
      payload: {
        chain: role,
        phase,
        ...peersField,
        ...(event.at === undefined ? {} : { warpAt: event.at }),
        ...(event.target === undefined ? {} : { warpTarget: event.target }),
        ...reasonField,
      },
    });
  }
}
