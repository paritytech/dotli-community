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
  /** Each chain's last phase other than a stall, the one a recovery returns to. */
  const resumable = new Map<string, ChainPhase>();

  function track(chain: string, kind: ChainSyncKind): ChainPhase | undefined {
    // With nothing known to return to, the chain is syncing until told otherwise.
    const phase = kind === 'recovered' ? (resumable.get(chain) ?? 'syncing') : PHASE_BY_MILESTONE[kind];
    if (phase !== undefined && phase !== 'stalled') {
      resumable.set(chain, phase);
    }
    return phase;
  }

  return track;
}
