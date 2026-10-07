// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Once chains exist it also holds the network watch and rechecks when the first chain would pass
// three block times, because a stalled chain sends no event. A hidden tab is judged when it shows.

import { getChainClocks, holdNetworkWatch, subscribeNetwork } from '../network-monitor.js';
import { judgeNetworkHealth, nextOverdueAt, type NetworkHealth } from '../network-health.js';
import { createSyncStore, registerStoreStateReset, type ReadableStore } from './create-store.js';

const health = createSyncStore<NetworkHealth>('network-health', 'idle');

export const networkHealthStore: ReadableStore<NetworkHealth> = health;

let stopInit: (() => void) | null = null;
let releaseWatch: (() => void) | null = null;
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
  const at = releaseWatch === null ? null : nextOverdueAt(clocks, now);
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
    setNetworkHealthWatched(false);
    stopInit = null;
  };
  stopInit = stop;
  return stop;
}

/** True while chains exist. */
export function setNetworkHealthWatched(watched: boolean): void {
  if (watched && releaseWatch === null) {
    releaseWatch = holdNetworkWatch();
    judge();
    return;
  }
  if (!watched && releaseWatch !== null) {
    releaseWatch();
    releaseWatch = null;
    judge();
  }
}

registerStoreStateReset(() => {
  stopInit?.();
  // A watch can be held without init (watchNetworkHealth alone).
  setNetworkHealthWatched(false);
  health.set('idle');
});
