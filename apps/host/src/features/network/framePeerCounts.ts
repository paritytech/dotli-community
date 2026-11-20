// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Records the frame's per-chain peer counts by listening only, so it opens no chain, lease or feed of its own.

import { getProtocolClient, type ProtocolClient } from '@dotli/protocol';
import { createSharedRun } from '@dotli/shared';
import { networkMonitorState, type NetworkMonitor } from './networkMonitorState.js';

type StartParams = {
  /** The frame's reports, the page's protocol client's unless given others. */
  telemetry?: Pick<ProtocolClient['telemetry'], 'subscribeChainSync'>;
  /** The monitor the counts go to, the page's unless given another. */
  monitor?: Pick<NetworkMonitor, 'recordPeerCount'>;
};

export function createFramePeerCounts() {
  const run = createSharedRun<Required<StartParams>>({ begin: beginFollowing });

  return {
    /**
     * Records each chain's peer count the frame reports in `monitor`, until the last caller's stop. A call while it runs
     * joins that run and ignores its params. Each returned stop acts once.
     */
    start,
  };

  function start({
    telemetry = getProtocolClient().telemetry,
    monitor = networkMonitorState,
  }: StartParams = {}): () => void {
    return run.join({ telemetry, monitor });
  }
}

/** The page's. */
export const framePeerCounts = createFramePeerCounts();

function beginFollowing({ telemetry, monitor }: Required<StartParams>): () => void {
  return telemetry.subscribeChainSync(event => {
    if (event.kind === 'peers' && event.peers !== undefined) {
      monitor.recordPeerCount(event.chain, event.peers);
    }
  });
}
