// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rechecks when the first live chain would pass three block times, because a stalled chain sends no event. A hidden
// tab is judged when it shows.

import { getChainClocks, subscribeNetwork } from '../network-monitor.js';
import { judgeNetworkHealth, nextOverdueAt, type NetworkHealth } from '../network-health.js';
import { createSyncStore, registerStoreStateReset, type ReadableStore } from './create-store.js';

const health = createSyncStore<NetworkHealth>('network-health', 'quiet');

export const networkHealthStore: ReadableStore<NetworkHealth> = health;

let stopInit: (() => void) | null = null;
let recheck: ReturnType<typeof setTimeout> | null = null;
/** Lets a notify that moves no deadline leave `recheck` be. */
let recheckAt: number | null = null;

function disarm(): void {
  if (recheck !== null) {
    clearTimeout(recheck);
  }
  recheck = null;
  recheckAt = null;
}

function judge(): void {
  if (document.hidden) {
    disarm();
    return;
  }
  const now = Date.now();
  const clocks = getChainClocks(now);
  health.set(judgeNetworkHealth(clocks, navigator.onLine));
  const at = nextOverdueAt(clocks, now);
  if (at === recheckAt) {
    return;
  }
  disarm();
  if (at !== null) {
    recheckAt = at;
    // One past the deadline: overdue is strictly past three block times.
    recheck = setTimeout(
      () => {
        recheck = null;
        recheckAt = null;
        judge();
      },
      at + 1 - now,
    );
  }
}

/** Calling it again returns the same stop. */
export function initNetworkHealth(): () => void {
  if (stopInit !== null) {
    return stopInit;
  }
  judge();
  const unsubscribe = subscribeNetwork(judge);
  window.addEventListener('online', judge);
  window.addEventListener('offline', judge);
  document.addEventListener('visibilitychange', judge);
  const stop = (): void => {
    unsubscribe();
    window.removeEventListener('online', judge);
    window.removeEventListener('offline', judge);
    document.removeEventListener('visibilitychange', judge);
    disarm();
    stopInit = null;
  };
  stopInit = stop;
  return stop;
}

registerStoreStateReset(() => {
  stopInit?.();
  disarm();
  health.set('quiet');
});
