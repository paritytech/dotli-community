// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, registerStoreStateReset, type ReadableStore } from '@dotli/shared';
import { networkMonitor, type ChainStatus, type NetworkMonitor, type TransferState } from './network-monitor.js';
import { describeLiveNetwork, type LiveVerdict } from '../network-verdict.js';

export interface NetworkState {
  chains: ChainStatus[];
  transfer: TransferState;
  /** When `chains` was read, so a countdown adds the time since to each `sinceLast`. */
  readAt: number;
  /** Over `chains`, worked out once per update, as the capsule's health judges it. */
  verdict: LiveVerdict;
}

/** What the store reads from the network monitor. */
export type NetworkFeed = Pick<NetworkMonitor, 'subscribe' | 'getNetworkStatus' | 'getTransfer'>;

export interface NetworkStore {
  store: ReadableStore<NetworkState>;
  /** Follows `monitor` until the returned stop, so a reader that mounts later reads a current store. */
  start: (monitor: NetworkFeed) => () => void;
}

function snapshot(from: NetworkFeed): NetworkState {
  const chains = from.getNetworkStatus();
  return {
    chains,
    transfer: from.getTransfer(),
    readAt: Date.now(),
    verdict: describeLiveNetwork(chains),
  };
}

export function createNetworkStore(): NetworkStore {
  const network = createSyncStore<NetworkState>('network', {
    chains: [],
    transfer: { bytesPerSecond: null, fetched: null, total: null },
    readAt: 0,
    verdict: { text: 'Not in use', tone: 'quiet' },
  });
  const readers = new Set<object>();
  /** The monitor the store last started on, which a stale `get` rebuilds from. */
  let feed: NetworkFeed | null = null;
  /** The monitor changed while nobody was subscribed, so `get` rebuilds. */
  let stale = false;
  registerStoreStateReset(() => {
    readers.clear();
    feed = null;
    stale = false;
  });

  const read = (): NetworkState => {
    if (stale && feed !== null) {
      stale = false;
      network.set(snapshot(feed));
    }
    return network.get();
  };

  return {
    /**
     * The monitor notifies on every chunk, speed sample and block, and the only reader mounts only while
     * open, so with nobody subscribed a change just marks the store stale.
     */
    store: {
      get: read,
      initial: network.initial,
      subscribe: listener => {
        const reader = {};
        readers.add(reader);
        const unsubscribe = network.subscribe(listener);
        return () => {
          readers.delete(reader);
          unsubscribe();
        };
      },
    },
    start(monitor) {
      feed = monitor;
      const sync = (): void => {
        if (readers.size === 0) {
          stale = true;
          return;
        }
        stale = false;
        network.set(snapshot(monitor));
      };
      sync();
      return monitor.subscribe(sync);
    },
  };
}

const page = createNetworkStore();

/** The page's, which the chains island reads. */
export const networkStore: ReadableStore<NetworkState> = page.store;

/** Started at boot on the page's monitor, so the chains island reads a current store whenever it mounts. */
export function startNetworkStore(monitor: NetworkFeed = networkMonitor): () => void {
  return page.start(monitor);
}
