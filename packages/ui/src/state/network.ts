// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getNetworkStatus,
  getTransfer,
  holdNetworkWatch,
  subscribeNetwork,
  type ChainStatus,
  type TransferState,
} from '../network-monitor.js';
import { createSyncStore, registerStoreStateReset, type ReadableStore } from './create-store.js';

export interface NetworkState {
  chains: ChainStatus[];
  transfer: TransferState;
  /** When `chains` was read, so a countdown adds the time since to each `sinceLast`. */
  readAt: number;
}

const network = createSyncStore<NetworkState>('network', {
  chains: [],
  transfer: { bytesPerSecond: null, fetched: null, total: null },
  readAt: 0,
});

const readers = new Set<object>();
/** The monitor changed while nobody was subscribed, so `get` rebuilds. */
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
 * The monitor notifies on every chunk, speed sample and block, and the only reader mounts only while
 * open, so with nobody subscribed a change just marks the store stale.
 */
export const networkStore: ReadableStore<NetworkState> = {
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

/** initTopBar starts it after setBlockSource, so the chains island reads a current store whenever it mounts. */
export function startNetworkStore(): () => void {
  sync();
  return subscribeNetwork(sync);
}

/**
 * Re-reads the monitor, because starting a watch changes what it reports without a notification.
 * The release lets the watch lapse after the monitor's idle grace once nobody else holds it.
 */
export function watchNetwork(): () => void {
  const release = holdNetworkWatch();
  sync();
  return release;
}
