// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getNetworkStatus,
  getTransfer,
  startNetworkWatch,
  stopNetworkWatch,
  subscribeNetwork,
  type ChainStatus,
  type TransferState,
} from '../network-monitor.js';
import { createSyncStore, registerStoreStateReset, type ReadableStore } from './create-store.js';

export interface NetworkState {
  chains: ChainStatus[];
  transfer: TransferState;
  /**
   * When `chains` was read (`Date.now()`): each chain's `sinceLast` is as of
   * then, so a countdown adds the time elapsed since.
   */
  readAt: number;
}

const network = createSyncStore<NetworkState>({
  chains: [],
  transfer: { bytesPerSecond: null, fetched: null, total: null },
  readAt: 0,
});

/** One token per live subscription. */
const readers = new Set<object>();
/** The monitor changed while nobody was subscribed; `get` rebuilds. */
let stale = false;
registerStoreStateReset(() => {
  readers.clear();
  stale = false;
});

function snapshot(): NetworkState {
  return {
    chains: getNetworkStatus(),
    transfer: getTransfer(),
    readAt: Date.now(),
  };
}

function read(): NetworkState {
  if (stale) {
    stale = false;
    network.set(snapshot());
  }
  return network.get();
}

/**
 * The monitor notifies on every content chunk, speed sample and block, and
 * the chains popover, the store's only reader, is mounted only while open.
 * With nobody subscribed, a change only marks the store stale, and the next
 * `get` builds the snapshot.
 */
export const networkStore: ReadableStore<NetworkState> = {
  get: read,
  subscribe: listener => {
    const reader = {};
    readers.add(reader);
    const unsubscribe = network.subscribe(listener);
    return () => {
      readers.delete(reader);
      unsubscribe();
    };
  },
};
export const getNetworkState = read;

function sync(): void {
  if (readers.size === 0) {
    stale = true;
    return;
  }
  stale = false;
  network.set(snapshot());
}

/**
 * Mirror the network monitor into the store, from now on. initTopBar starts
 * it at boot, after setBlockSource, so the chains island reads a current
 * store whenever it mounts. Returns the stop.
 */
export function startNetworkStore(): () => void {
  sync();
  return subscribeNetwork(sync);
}

/**
 * Watch every chain's block arrivals, for the chains popover while it is
 * open, and re-read the monitor: starting a watch and what the backend can
 * reach change what it reports without a notification. Returns the stop,
 * which lets the watch lapse after the monitor's idle grace.
 */
export function watchNetwork(): () => void {
  startNetworkWatch();
  sync();
  return stopNetworkWatch;
}
