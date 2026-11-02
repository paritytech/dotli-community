// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainSyncKind } from '@dotli/chains';
import type { ChainPhase } from './state/networkMonitorState.js';
import { PHASE_BY_MILESTONE } from './phaseByMilestone.js';

/**
 * Per chain, the phase each milestone leaves it in. A stall interrupts a phase rather than replacing it, and the light
 * client sends no new phase for one it never left, so recovery returns the chain to the phase the stall interrupted.
 */
export function createChainPhaseTracker(): (chain: string, kind: ChainSyncKind) => ChainPhase | undefined {
  const current = new Map<string, ChainPhase>();
  const beforeStall = new Map<string, ChainPhase>();

  function track(chain: string, kind: ChainSyncKind): ChainPhase | undefined {
    const now = current.get(chain);
    let phase: ChainPhase | undefined;
    if (kind === 'recovered') {
      // With nothing known to return to, the chain is syncing until told otherwise.
      phase = now === 'stalled' ? (beforeStall.get(chain) ?? 'syncing') : (now ?? 'syncing');
    } else {
      phase = PHASE_BY_MILESTONE[kind];
      if (phase === 'stalled' && now !== undefined && now !== 'stalled') {
        beforeStall.set(chain, now);
      }
    }
    if (phase !== undefined) {
      current.set(chain, phase);
    }
    return phase;
  }

  return track;
}
