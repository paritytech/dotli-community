// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  getNetworkStatus,
  getTransfer,
  subscribeNetwork,
  type ChainStatus,
} from "../network-monitor";
import { createSyncStore, type ReadableStore } from "./create-store";

export interface NetworkState {
  chains: ChainStatus[];
  transfer: ReturnType<typeof getTransfer>;
}

const network = createSyncStore<NetworkState>({
  chains: [],
  transfer: { bytesPerSecond: null, fetched: null, total: null },
});

export const networkStore: ReadableStore<NetworkState> = network;
export const getNetworkState = network.get;

/**
 * Mirror the network monitor into the store. Not called by production code
 * until the chains popover becomes a component (sub-project 4); the popover
 * starts it while open, as it does with `subscribeNetwork` today.
 */
export function startNetworkStore(): () => void {
  const sync = (): void => {
    network.set({ chains: getNetworkStatus(), transfer: getTransfer() });
  };
  sync();
  return subscribeNetwork(sync);
}
