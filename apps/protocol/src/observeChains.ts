// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import type { ChainPool } from '@dotli/chains';

type Params = {
  /** The pool whose chains are held. */
  pool: Pick<ChainPool, 'getLocalProvider'>;
  /** The chains to hold, by genesis hash. */
  genesisHashes: readonly string[];
};

/**
 * Holds an idle pool lease on each chain so its sync can be observed. The pool rebuilds a halted chain under the lease,
 * so the observer never takes it again.
 *
 * The relay needs this because papi never dials it, yet its warp sync is the slowest cold-start step and the only one
 * with a real percentage. Returns the stop, which lets go of every lease and may run more than once.
 */
export function observeChains({ pool, genesisHashes }: Params): () => void {
  const leases = new Map<string, JsonRpcConnection>();

  for (const genesisHash of genesisHashes) {
    take(genesisHash);
  }

  return stop;

  function stop(): void {
    // A second stop finds nothing left.
    for (const lease of [...leases.values()]) {
      lease.disconnect();
    }
    leases.clear();
  }

  function take(genesisHash: string): void {
    // A chain listed twice builds nothing.
    if (leases.has(genesisHash)) {
      return;
    }
    const provider = pool.getLocalProvider(genesisHash, { holder: 'sync-observer' });
    if (provider === null) {
      return;
    }
    leases.set(
      genesisHash,
      provider(() => {
        // The tap consumes its own responses before here, the rest is chatter nobody reads.
      }),
    );
  }
}
