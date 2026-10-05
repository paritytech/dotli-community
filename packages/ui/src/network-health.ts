// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network health the status capsule and the network badge show, as the
// status tone they colour it with. It is the network menu's own verdict, so
// the two never disagree.

import type { StatusTone } from './components/primitives/StatusDot.js';
import { describeLiveNetwork } from './components/shell/chains-format.js';
import type { ChainStatus } from './network-monitor.js';

/** ok, idle (syncing), warn (unstable) or err (offline). */
export type NetworkHealth = Extract<StatusTone, 'ok' | 'idle' | 'warn' | 'err'>;

export function judgeNetworkHealth(status: readonly ChainStatus[], online: boolean): NetworkHealth {
  return online ? describeLiveNetwork(status).tone : 'err';
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
