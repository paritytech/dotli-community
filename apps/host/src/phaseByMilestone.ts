// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainSyncKind } from '@dotli/chains';
import type { ChainPhase } from './state/networkMonitorState.js';

/** The phase each milestone names. Milestones that name no phase are absent, so a lone peer count never moves a chain. */
export const PHASE_BY_MILESTONE: Partial<Record<ChainSyncKind, ChainPhase>> = {
  connecting: 'connecting',
  warpSyncProgress: 'syncing',
  warpSyncFinished: 'ready',
  bootstrapComplete: 'ready',
  stalled: 'stalled',
};
