// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainBrokerManager } from '@dotli/protocol';

/**
 * Hold a pool lease on each chain for no reason but to watch it.
 *
 * Every other lease exists because something reads that chain. The relay is
 * the exception: smoldot runs it as the parent of the parachains, so papi never
 * dials it and no sync tap would ever attach. Its warp sync is both the slowest
 * part of a cold start and the only one that reports a true percentage, which
 * is worth one otherwise idle lease to observe.
 *
 * Returns a stop function that releases the leases. A genesis this network
 * does not define is skipped.
 */
export function observeChains(pool: ChainBrokerManager, genesisHashes: readonly string[]): () => void {
  const connections: { disconnect(): void }[] = [];
  for (const genesisHash of genesisHashes) {
    const provider = pool.getLocalProvider(genesisHash);
    if (provider === null) {
      continue;
    }
    connections.push(
      provider(() => {
        // Nothing reads these chains. Responses to the requests the tap itself sent are
        // consumed before they reach here. Anything else is chain chatter we
        // opened the connection to provoke, not to handle.
      }),
    );
  }
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const connection of connections) {
      connection.disconnect();
    }
  };
}
