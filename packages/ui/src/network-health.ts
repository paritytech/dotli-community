// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one-word network health the status capsule and the network badge
// show. It is the network menu's own verdict, so the two never disagree.

import type { StatusTone } from './components/primitives/StatusDot.js';
import { describeLiveNetwork } from './components/shell/chains-format.js';
import type { ChainStatus } from './network-monitor.js';

export type NetworkHealth = 'ok' | 'syncing' | 'degraded' | 'offline';

export function judgeNetworkHealth(status: readonly ChainStatus[], online: boolean): NetworkHealth {
  if (!online) {
    return 'offline';
  }
  const { tone } = describeLiveNetwork(status);
  if (tone === 'ok') {
    return 'ok';
  }
  return tone === 'warn' ? 'degraded' : 'syncing';
}

const TONES: Record<NetworkHealth, StatusTone> = {
  ok: 'ok',
  syncing: 'idle',
  degraded: 'warn',
  offline: 'err',
};

export function healthTone(health: NetworkHealth): StatusTone {
  return TONES[health];
}

const WORDS: Record<NetworkHealth, string> = {
  ok: 'Connected',
  syncing: 'Syncing',
  degraded: 'Unstable',
  offline: 'Offline',
};

/** The verdict in one word, for the More menu's Network row. */
export function healthWord(health: NetworkHealth): string {
  return WORDS[health];
}
