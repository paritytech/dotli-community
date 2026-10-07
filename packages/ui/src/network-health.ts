// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The status capsule and network badge reuse the network menu's verdict so the two never disagree.

import type { StatusTone } from './components/primitives/StatusDot.js';
import { describeLiveNetwork } from './components/shell/chains-format.js';
import type { ChainClock } from './network-monitor.js';

export type NetworkHealth = Extract<StatusTone, 'ok' | 'idle' | 'warn' | 'err'>;

export function judgeNetworkHealth(status: readonly ChainClock[], online: boolean): NetworkHealth {
  return online ? describeLiveNetwork(status).tone : 'err';
}

/** When the verdict next changes with no event, the first on-time chain going overdue. Null when none can. */
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

export function healthWord(health: NetworkHealth): string {
  return WORDS[health];
}
