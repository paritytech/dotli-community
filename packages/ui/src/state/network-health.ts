// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network health the status capsule and the network badge read. From
// boot it follows the browser's online events. Once chains exist (the
// network button shows) it also holds the network watch and rechecks every
// second, because a chain that stops producing blocks sends no event.

import { getNetworkStatus, holdNetworkWatch, subscribeNetwork } from '../network-monitor.js';
import { judgeNetworkHealth, type NetworkHealth } from '../network-health.js';
import { createSyncStore, registerStoreStateReset, type ReadableStore } from './create-store.js';

const RECHECK_MS = 1000;

const health = createSyncStore<NetworkHealth>('network-health', 'idle');

export const networkHealthStore: ReadableStore<NetworkHealth> = health;

let stopInit: (() => void) | null = null;
let releaseWatch: (() => void) | null = null;
let recheck: ReturnType<typeof setInterval> | null = null;

function judge(): void {
  health.set(judgeNetworkHealth(getNetworkStatus(), navigator.onLine));
}

/** Start following the network. Calling it again returns the same stop. */
export function initNetworkHealth(): () => void {
  if (stopInit !== null) {
    return stopInit;
  }
  judge();
  const unsubscribe = subscribeNetwork(judge);
  window.addEventListener('online', judge);
  window.addEventListener('offline', judge);
  const stop = (): void => {
    unsubscribe();
    window.removeEventListener('online', judge);
    window.removeEventListener('offline', judge);
    setNetworkHealthWatched(false);
    stopInit = null;
  };
  stopInit = stop;
  return stop;
}

/** Chains exist (true) or are gone (false): hold or release the watch. */
export function setNetworkHealthWatched(watched: boolean): void {
  if (watched && releaseWatch === null) {
    releaseWatch = holdNetworkWatch();
    recheck = setInterval(judge, RECHECK_MS);
    judge();
    return;
  }
  if (!watched && releaseWatch !== null) {
    releaseWatch();
    releaseWatch = null;
    if (recheck !== null) {
      clearInterval(recheck);
      recheck = null;
    }
    judge();
  }
}

registerStoreStateReset(() => {
  stopInit?.();
  // A watch can be held without init (setChainsButtonVisible alone).
  setNetworkHealthWatched(false);
  health.set('idle');
});
