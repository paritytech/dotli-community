// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Rechecks when the first live chain would turn overdue, because a stalled chain sends no event. A hidden tab is
// judged when it shows.

import {
  createSharedRun,
  createSyncStore,
  listen,
  realTimers,
  registerStoreStateReset,
  type ReadableStore,
  type Timers,
} from '@dotli/shared';
import { networkMonitorState, type NetworkMonitor } from './networkMonitorState.js';
import { getNextOverdueAt, judgeNetworkHealth, type NetworkHealth } from '../networkVerdict.js';

/** What the health reads from the page around the chains. */
type HealthPage = {
  /** Whether the tab is hidden now. Never throws. */
  isHidden: () => boolean;
  /** Whether the browser reports a connection now. Never throws. */
  isOnline: () => boolean;
  /** Fires `visibilitychange`. */
  visibility: EventTarget;
  /** Fires `online` and `offline`. */
  connectivity: EventTarget;
};

type Params = {
  /** The clock the health is judged at and the timer its recheck waits on. */
  timers?: Pick<Timers, 'now' | 'setTimeout' | 'clearTimeout'>;
};

type StartParams = {
  /** The monitor to judge, the page's unless given another. */
  monitor?: Pick<NetworkMonitor, 'subscribe' | 'getChainClocks'>;
  /** The page around the chains, the browser's unless given another. */
  page?: HealthPage;
};

export function createNetworkHealthState({ timers = realTimers }: Params = {}) {
  const health = createSyncStore<NetworkHealth>({ name: 'network-health', initial: 'quiet' });
  const store: ReadableStore<NetworkHealth> = health;
  let recheck: unknown = null;
  /** Lets a notify that moves no deadline leave `recheck` be. */
  let recheckAt: number | null = null;
  const run = createSharedRun<Required<StartParams>>({ begin: beginFollowing });
  registerStoreStateReset(() => {
    run.end();
    disarm();
    health.set('quiet');
  });

  return {
    /** The health of the chains in use, `quiet` until started. */
    store,
    /**
     * Judges the health on every change of `monitor`, `page`'s connectivity and visibility, and when the first live
     * chain would turn overdue, until the last caller's stop. A call while it runs joins that run and ignores its
     * params. Each returned stop acts once. Never throws.
     */
    start,
  };

  function start({ monitor = networkMonitorState, page = createBrowserHealthPage() }: StartParams = {}): () => void {
    return run.join({ monitor, page });
  }

  function beginFollowing({ monitor, page }: Required<StartParams>): () => void {
    judge();
    const unsubscribes = [
      monitor.subscribe(judge),
      listen({ target: page.connectivity, type: 'online', handler: judge }),
      listen({ target: page.connectivity, type: 'offline', handler: judge }),
      listen({ target: page.visibility, type: 'visibilitychange', handler: judge }),
    ];
    return stopJudging;

    function judge(): void {
      if (page.isHidden()) {
        disarm();
        return;
      }
      const now = timers.now();
      const clocks = monitor.getChainClocks(now);
      health.set(judgeNetworkHealth(clocks, page.isOnline()));
      const at = getNextOverdueAt(clocks, now);
      if (at === recheckAt) {
        return;
      }
      disarm();
      if (at !== null) {
        recheckAt = at;
        // One past the deadline: overdue is strictly past three block times.
        recheck = timers.setTimeout(judgeAgain, at + 1 - now);
      }
    }

    function judgeAgain(): void {
      recheck = null;
      recheckAt = null;
      judge();
    }

    function stopJudging(): void {
      for (const unsubscribeOne of unsubscribes) {
        unsubscribeOne();
      }
      disarm();
    }
  }

  function disarm(): void {
    if (recheck !== null) {
      timers.clearTimeout(recheck);
    }
    recheck = null;
    recheckAt = null;
  }
}

/** The page's, on the page's own clock. */
export const networkHealthState = createNetworkHealthState();

function createBrowserHealthPage(): HealthPage {
  return {
    isHidden: () => document.hidden,
    isOnline: () => navigator.onLine,
    visibility: document,
    connectivity: window,
  };
}
