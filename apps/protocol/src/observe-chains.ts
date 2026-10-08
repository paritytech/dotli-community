// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainBrokerManager } from '@dotli/protocol';

/**
 * Holds an idle pool lease on each chain so its sync can be observed.
 *
 * The relay needs this because papi never dials it, yet its warp sync is the slowest cold-start step and the only one
 * with a real percentage.
 */
export function observeChains(pool: ChainBrokerManager, genesisHashes: readonly string[]): () => void {
  const connections: { disconnect(): void }[] = [];
  for (const genesisHash of genesisHashes) {
    const provider = pool.getLocalProvider(genesisHash, 'sync-observer');
    if (provider === null) {
      continue;
    }
    connections.push(
      provider(() => {
        // The tap consumes its own responses before here, the rest is chatter nobody reads.
      }),
    );
  }
  return () => {
    // Emptied so a second stop is a no-op.
    for (const connection of connections.splice(0)) {
      connection.disconnect();
    }
  };
}
