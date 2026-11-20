// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChainSyncEvent } from '@dotli/chains';
import type { ChainRole } from '@dotli/config';
import { createListenerSet, type ListenerSet } from '@dotli/shared';
import { resetAllStoresForTests as resetStores } from '@dotli/shared/testing';
import { createFramePeerCounts } from './framePeerCounts.js';
import { createNetworkMonitorState } from './networkMonitorState.js';
import { rethrow } from '../../testing/rethrow.js';

/** The frame's chain sync reports, emitted by hand. */
let chainSync: ListenerSet<ChainSyncEvent>;
/** The frame's reports, as the protocol client hands them on. */
let telemetry: { subscribeChainSync: ListenerSet<ChainSyncEvent>['subscribe'] };
let peerCounts: ReturnType<typeof createFramePeerCounts>;

beforeEach(() => {
  chainSync = createListenerSet<ChainSyncEvent>({ onListenerError: rethrow });
  telemetry = { subscribeChainSync: chainSync.subscribe };
  peerCounts = createFramePeerCounts();
});

afterEach(() => {
  resetStores();
});

describe('The frame peer counts', () => {
  it('As a visitor on the landing page, I see the peer count the frame reports for a chain in the network monitor', () => {
    // Given
    const monitor = createNetworkMonitorState({ isConnectable: () => true });
    peerCounts.start({ telemetry, monitor });

    // When
    chainSync.emit({ chain: 'relay', kind: 'firstPeer' });
    chainSync.emit({ chain: 'relay', kind: 'peers', peers: 4, isSyncing: false });

    // Then
    expect(monitor.getNetworkStatus().find(chain => chain.role === 'relay')?.peers).toBe(4);
  });

  it('As a landing page whose start stopped, I record no later peer count', () => {
    // Given
    const { monitor, recorded } = createRecordingMonitor();
    const stop = peerCounts.start({ telemetry, monitor });
    stop();

    // When
    chainSync.emit({ chain: 'relay', kind: 'peers', peers: 4, isSyncing: false });

    // Then
    expect(recorded).toEqual([]);
  });
});

function createRecordingMonitor() {
  const recorded: [ChainRole, number][] = [];
  return {
    recorded,
    monitor: {
      recordPeerCount(chain: ChainRole, peers: number): void {
        recorded.push([chain, peers]);
      },
    },
  };
}
