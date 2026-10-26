// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rechecks when the first live chain would turn overdue, because a stalled chain sends no event. A hidden tab is
// judged when it shows.

import { networkMonitor, type NetworkMonitor } from './network-monitor.js';
import { createSyncStore, listen, registerStoreStateReset, type ReadableStore } from '@dotli/shared';
import { judgeNetworkHealth, nextOverdueAt, type NetworkHealth } from '../network-verdict.js';

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

/** What the health reads from the page around the chains. */
export interface HealthPage {
  isHidden: () => boolean;
  isOnline: () => boolean;
  /** Fires `visibilitychange`. */
  visibility: EventTarget;
  /** Fires `online` and `offline`. */
  connectivity: EventTarget;
}

function browserHealthPage(): HealthPage {
  return {
    isHidden: () => document.hidden,
    isOnline: () => navigator.onLine,
    visibility: document,
    connectivity: window,
  };
}

/** Calling it again returns the same stop. Judged on the page's monitor unless given another. */
export function startNetworkHealth(
  monitor: Pick<NetworkMonitor, 'subscribe' | 'getChainClocks'> = networkMonitor,
  page: HealthPage = browserHealthPage(),
): () => void {
  if (stopInit !== null) {
    return stopInit;
  }
  const judge = (): void => {
    if (page.isHidden()) {
      disarm();
      return;
    }
    const now = Date.now();
    const clocks = monitor.getChainClocks(now);
    health.set(judgeNetworkHealth(clocks, page.isOnline()));
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
  };
  judge();
  const stops = [
    monitor.subscribe(judge),
    listen(page.connectivity, 'online', judge),
    listen(page.connectivity, 'offline', judge),
    listen(page.visibility, 'visibilitychange', judge),
  ];
  const stop = (): void => {
    for (const stopOne of stops) {
      stopOne();
    }
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
