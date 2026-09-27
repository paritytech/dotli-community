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
} from "../network-monitor";
import { createSyncStore, type ReadableStore } from "./create-store";

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

export const networkStore: ReadableStore<NetworkState> = network;
export const getNetworkState = network.get;

function sync(): void {
  network.set({
    chains: getNetworkStatus(),
    transfer: getTransfer(),
    readAt: Date.now(),
  });
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
