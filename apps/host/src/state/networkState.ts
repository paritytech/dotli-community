// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { computed, type ReadableAtom } from 'nanostores';
import { realTimers, type Timers } from '@dotli/shared';
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
type NetworkFeed = Pick<NetworkMonitor, 'version' | 'getNetworkStatus' | 'getTransfer'>;

type Params = {
  /** The clock each read's `readAt` comes from. */
  timers?: Pick<Timers, 'now'>;
  /** The monitor to read, the page's unless given another. */
  monitor?: NetworkFeed;
};

/** Builds the chains, transfer and verdict as of the last read after a monitor change. */
export function createNetworkState({
  timers = realTimers,
  monitor = networkMonitorState,
}: Params = {}): ReadableAtom<NetworkState> {
  // A monitor can change many times a second, so the snapshot is rebuilt only while someone listens, for a second after
  // the last one leaves, and on a `get` after a change.
  return computed(monitor.version, readSnapshot);

  function readSnapshot(): NetworkState {
    const chains = monitor.getNetworkStatus();
    return {
      chains,
      transfer: monitor.getTransfer(),
      readAt: timers.now(),
      verdict: describeLiveNetwork(chains),
    };
  }
}

/** The page's, on the page's own clock. */
export const networkState = createNetworkState();
