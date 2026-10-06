// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network health the status capsule and the network badge show, as the
// status tone they colour it with. It is the network menu's own verdict, so
// the two never disagree.

import type { StatusTone } from './components/primitives/StatusDot.js';
import { describeLiveNetwork } from './components/shell/chains-format.js';
import type { ChainClock } from './network-monitor.js';

/** ok, idle (syncing), warn (unstable) or err (offline). */
export type NetworkHealth = Extract<StatusTone, 'ok' | 'idle' | 'warn' | 'err'>;

export function judgeNetworkHealth(status: readonly ChainClock[], online: boolean): NetworkHealth {
  return online ? describeLiveNetwork(status).tone : 'err';
}

/**
 * When the verdict next changes with no event: the first moment a chain that
 * is on time now passes three block times without a block (describeLiveNetwork's
 * overdue). Null when no chain can, before any block or with all overdue.
 */
export function nextOverdueAt(status: readonly ChainClock[], now: number): number | null {
  let at: number | null = null;
  for (const chain of status) {
    if (!chain.reachable || chain.latest === null || chain.sinceLast === null) {
      continue;
    }
    const limit = chain.blockTimeMs * 3;
    if (chain.sinceLast <= limit) {
      const due = now - chain.sinceLast + limit;
      at = at === null ? due : Math.min(at, due);
    }
  }
  return at;
}

const WORDS: Record<NetworkHealth, string> = {
  ok: 'Connected',
  idle: 'Syncing',
  warn: 'Unstable',
  err: 'Offline',
};

/** The verdict in one word, for the More menu's Network row. */
export function healthWord(health: NetworkHealth): string {
  return WORDS[health];
}
