// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createSharedRun,
  createSyncStore,
  realTimers,
  registerStoreStateReset,
  type ReadableStore,
  type Timers,
} from '@dotli/shared';
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
  const run = createSharedRun<Required<StartParams>>({ begin: beginFollowing });
  registerStoreStateReset(() => {
    run.end();
    readers.clear();
    feed = null;
    stale = false;
  });

  // A followed monitor can notify many times a second, so with nobody subscribed a change only marks the store stale,
  // and the next `get` rebuilds it.
  const store: ReadableStore<NetworkState> = {
    get,
    init: network.init,
    listen,
  };

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

  function listen(listener: (value: NetworkState, oldValue: NetworkState | undefined) => void): () => void {
    const reader = {};
    readers.add(reader);
    const unlisten = network.listen(listener);
    return () => {
      readers.delete(reader);
      unlisten();
    };
  }

  function start({ monitor = networkMonitorState }: StartParams = {}): () => void {
    return run.join({ monitor });
  }

  function beginFollowing({ monitor }: Required<StartParams>): () => void {
    feed = monitor;
    sync();
    return monitor.subscribe(sync);

    function sync(): void {
      if (readers.size === 0) {
        stale = true;
        return;
      }
      stale = false;
      network.set(readSnapshot(monitor));
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
