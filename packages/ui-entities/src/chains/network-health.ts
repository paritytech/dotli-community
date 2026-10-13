// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StatusTone } from '@dotli/ui-core';

/** The page's network health, as the network button's badge and its More row show it. */
export type NetworkHealth = Extract<StatusTone, 'ok' | 'idle' | 'warn' | 'err' | 'quiet'>;

const WORDS: Record<NetworkHealth, string> = {
  ok: 'Connected',
  idle: 'Syncing',
  warn: 'Unstable',
  err: 'Offline',
  quiet: 'Not in use',
};

export function healthWord(health: NetworkHealth): string {
  return WORDS[health];
}
