// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network health with its per-health facts, the one verdict over the chains in use, and the deadline at which a
// chain in use turns overdue, so every reader of the network agrees.

import type { StatusTone } from '@dotli/ui';
import type { ChainClock } from './state/networkMonitorState.js';

/** The page's network health, a status tone the dot, the badge and More's row show. */
export type NetworkHealth = Extract<StatusTone, 'ok' | 'idle' | 'warn' | 'err' | 'quiet'>;

type HealthFacts = {
  /** The health as the badge's More row says it. */
  word: string;
  /** The network panel's status title. */
  title: string;
  /** Whether More raises an alert for it. */
  alerts: boolean;
  /** Whether the status dot pulses. */
  pulses: boolean;
};

export type LiveVerdict = {
  tone: Exclude<NetworkHealth, 'err'>;
  /** The chains behind a warning, by label. */
  slow?: readonly string[];
};

export const NETWORK_HEALTH = {
  ok: { word: 'Connected', title: 'Your connection is good', alerts: false, pulses: false },
  idle: { word: 'Syncing', title: 'Syncing', alerts: true, pulses: true },
  warn: { word: 'Unstable', title: 'Connection is unstable', alerts: true, pulses: false },
  err: { word: 'Offline', title: 'You are offline', alerts: true, pulses: false },
  quiet: { word: 'Not in use', title: 'No chains in use', alerts: false, pulses: false },
} satisfies Record<NetworkHealth, HealthFacts>;

/** A live chain is overdue past this many block times without a block. */
const OVERDUE_BLOCK_TIMES = 3;

/** What the verdict reads of a chain. */
type ChainTiming = Pick<ChainClock, 'label' | 'sinceLast' | 'blockTimeMs' | 'state' | 'alarm'>;

/**
 * The overall verdict, over the chains in use or pending only. It judges no connection milestone itself, only each
 * chain's state, alarm and time since its last block, so a verdict cannot latch on a dead connection.
 */
export function describeLiveNetwork(status: readonly ChainTiming[]): LiveVerdict {
  const counted = status.filter(chain => chain.state !== 'unused');
  if (counted.length === 0) {
    return { tone: 'quiet' };
  }
  const slow = counted.filter(chain => chain.alarm || isOverdue(chain)).map(chain => chain.label);
  if (slow.length > 0) {
    return { tone: 'warn', slow };
  }
  const live = counted.filter(chain => chain.state === 'live').length;
  if (live < counted.length) {
    return { tone: 'idle' };
  }
  return { tone: 'ok' };
}

/** Returns the status dot's tone: the live verdict's, or `err` while the browser is offline. */
export function judgeNetworkHealth(status: readonly ChainTiming[], online: boolean): NetworkHealth {
  return online ? describeLiveNetwork(status).tone : 'err';
}

/** Whether the health says the browser is offline. */
export function isNetworkOffline(health: NetworkHealth): boolean {
  switch (health) {
    case 'err':
      return true;
    case 'ok':
    case 'idle':
    case 'warn':
    case 'quiet':
      return false;
  }
}

/** Returns when the verdict next changes with no event, the first on-time chain going overdue. Null when none can. */
export function getNextOverdueAt(status: readonly ChainTiming[], now: number): number | null {
  let at: number | null = null;
  for (const chain of status) {
    if (chain.state !== 'live' || chain.alarm || chain.sinceLast === null) {
      continue;
    }
    const limit = chain.blockTimeMs * OVERDUE_BLOCK_TIMES;
    if (chain.sinceLast <= limit) {
      const due = now - chain.sinceLast + limit;
      at = at === null ? due : Math.min(at, due);
    }
  }
  return at;
}

/** Returns whether a live chain is past its overdue deadline. */
function isOverdue(chain: ChainTiming): boolean {
  return (
    chain.state === 'live' && chain.sinceLast !== null && chain.sinceLast > chain.blockTimeMs * OVERDUE_BLOCK_TIMES
  );
}
