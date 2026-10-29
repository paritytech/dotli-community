// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, realTimers, registerStoreStateReset, type ReadableStore, type Timers } from '@dotli/shared';
import {
  networkMonitorState,
  type ChainStatus,
  type NetworkMonitor,
  type TransferState,
} from './networkMonitorState.js';
import { describeLiveNetwork, type LiveVerdict } from '../networkVerdict.js';

export type NetworkState = {
  chains: ChainStatus[];
  transfer: TransferState;
  /** When `chains` was read, so a countdown adds the time since to each `sinceLast`. */
  readAt: number;
  /** The live network verdict over `chains`, worked out once per update. */
  verdict: LiveVerdict;
};

/** What the store reads from the network monitor. */
type NetworkFeed = Pick<NetworkMonitor, 'subscribe' | 'getNetworkStatus' | 'getTransfer'>;

type Params = {
  /** The clock each read's `readAt` comes from. */
  timers?: Pick<Timers, 'now'>;
};

type StartParams = {
  /** The monitor to follow, the page's unless given another. */
  monitor?: NetworkFeed;
};

/** The one follow of a monitor, shared by every caller of `start` until the last one stops. */
type Following = {
  /** Ends the follow's subscription. Never throws. */
  unsubscribe: () => void;
  /** How many callers of `start` have not stopped yet. */
  callers: number;
};

export function createNetworkState({ timers = realTimers }: Params = {}) {
  const network = createSyncStore<NetworkState>({
    name: 'network',
    initial: {
      chains: [],
      transfer: { bytesPerSecond: null, fetched: null, total: null },
      readAt: 0,
      verdict: { text: 'Not in use', tone: 'quiet' },
    },
  });
  const readers = new Set<object>();
  /** The monitor the store last started on, which a stale `get` rebuilds from. */
  let feed: NetworkFeed | null = null;
  /** The monitor changed while nobody was subscribed, so `get` rebuilds. */
  let stale = false;
  let following: Following | null = null;
  registerStoreStateReset(() => {
    if (following !== null) {
      endFollowing(following);
    }
    readers.clear();
    feed = null;
    stale = false;
  });

  // A followed monitor can notify many times a second, so with nobody subscribed a change only marks the store stale,
  // and the next `get` rebuilds it.
  const store: ReadableStore<NetworkState> = { get, initial: network.initial, subscribe };

  return {
    /** The chains, transfer and verdict as of the last read. Rebuilt on `get` when it went stale unwatched. */
    store,
    /**
     * Follows `monitor` until the last caller's stop, so a reader that mounts later reads a current store. A call while
     * it follows joins that follow and ignores its params. Each returned stop acts once. Never throws.
     */
    start,
  };

  function get(): NetworkState {
    if (stale && feed !== null) {
      stale = false;
      network.set(readSnapshot(feed));
    }
    return network.get();
  }

  function subscribe(listener: () => void): () => void {
    const reader = {};
    readers.add(reader);
    const unsubscribe = network.subscribe(listener);
    return unsubscribeReader;

    function unsubscribeReader(): void {
      readers.delete(reader);
      unsubscribe();
    }
  }

  function start({ monitor = networkMonitorState }: StartParams = {}): () => void {
    const run = following ?? beginFollowing(monitor);
    following = run;
    run.callers += 1;
    let stopped = false;
    return stopFollowing;

    function stopFollowing(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      run.callers -= 1;
      if (run.callers === 0) {
        endFollowing(run);
      }
    }
  }

  function beginFollowing(monitor: NetworkFeed): Following {
    feed = monitor;
    sync();
    return { unsubscribe: monitor.subscribe(sync), callers: 0 };

    function sync(): void {
      if (readers.size === 0) {
        stale = true;
        return;
      }
      stale = false;
      network.set(readSnapshot(monitor));
    }
  }

  function endFollowing(run: Following): void {
    run.unsubscribe();
    if (following === run) {
      following = null;
    }
  }

  function readSnapshot(from: NetworkFeed): NetworkState {
    const chains = from.getNetworkStatus();
    return {
      chains,
      transfer: from.getTransfer(),
      readAt: timers.now(),
      verdict: describeLiveNetwork(chains),
    };
  }
}

/** The page's, on the page's own clock. */
export const networkState = createNetworkState();
