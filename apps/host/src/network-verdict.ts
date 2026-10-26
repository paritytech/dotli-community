// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one verdict over the chains in use. The status capsule, the network badge and the network menu all read it, so
// they never disagree, and the health rechecks at the deadline the verdict judges overdue by.

import type { ChainClock } from './state/network-monitor.js';

/** The tones of a status dot the network health takes. */
export type NetworkHealth = 'ok' | 'idle' | 'warn' | 'err' | 'quiet';

export type LiveVerdict = {
  text: string;
  tone: Exclude<NetworkHealth, 'err'>;
  /** The chains behind a warning, by label. */
  slow?: readonly string[];
};

/** A live chain is overdue past this many block times without a block. */
const OVERDUE_BLOCK_TIMES = 3;

/** What the verdict reads of a chain. */
type ChainTiming = Pick<ChainClock, 'label' | 'sinceLast' | 'blockTimeMs' | 'state' | 'alarm'>;

/** Live but overdue, which the monitor leaves to the verdict so overdue is judged in one place. */
function isOverdue(chain: ChainTiming): boolean {
  return (
    chain.state === 'live' && chain.sinceLast !== null && chain.sinceLast > chain.blockTimeMs * OVERDUE_BLOCK_TIMES
  );
}

/**
 * The overall verdict, over the chains in use or pending only. Lifecycle milestones reach it through the monitor's
 * state and alarm, never directly, so a verdict cannot latch on a dead connection.
 */
export function describeLiveNetwork(status: readonly ChainTiming[]): LiveVerdict {
  const counted = status.filter(chain => chain.state !== 'unused');
  if (counted.length === 0) {
    return { text: 'Not in use', tone: 'quiet' };
  }
  const slow = counted.filter(chain => chain.alarm || isOverdue(chain)).map(chain => chain.label);
  if (slow.length > 0) {
    return { text: `Waiting on ${slow.join(' and ')}`, tone: 'warn', slow };
  }
  const live = counted.filter(chain => chain.state === 'live').length;
  if (live === 0) {
    return { text: 'Connecting', tone: 'idle' };
  }
  if (live < counted.length) {
    return { text: `Connecting, ${String(live)} of ${String(counted.length)} ready`, tone: 'idle' };
  }
  return { text: 'Your connection is good', tone: 'ok' };
}

export function judgeNetworkHealth(status: readonly ChainTiming[], online: boolean): NetworkHealth {
  return online ? describeLiveNetwork(status).tone : 'err';
}

/** When the verdict next changes with no event, the first on-time chain going overdue. Null when none can. */
export function nextOverdueAt(status: readonly ChainClock[], now: number): number | null {
  let at: number | null = null;
  for (const chain of status) {
    if (chain.state !== 'live' || chain.alarm || chain.latest === null || chain.sinceLast === null) {
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
