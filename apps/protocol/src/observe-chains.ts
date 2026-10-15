// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainPool } from '@dotli/chains';
import { reportListener } from '@dotli/metrics';
import { createAsyncTaskPool } from '@dotli/shared';

/** The wait before a halted chain is taken again, so a chain that keeps halting cannot spin the worker. */
const RETAKE_DELAY_MS = 1_000;

// A re-take that throws is a defect in the pool. It is reported, and the other chains stay watched.
const reportRetake = reportListener('protocol', 'sync_observer.retake');

/**
 * Holds an idle pool lease on each chain so its sync can be observed, and takes it again after the chain halts and the
 * pool rebuilds it.
 *
 * The relay needs this because papi never dials it, yet its warp sync is the slowest cold-start step and the only one
 * with a real percentage.
 */
export function observeChains(
  pool: Pick<ChainPool, 'getLocalProvider'>,
  genesisHashes: readonly string[],
  retakeDelayMs: number = RETAKE_DELAY_MS,
): () => void {
  const leases = new Map<string, { disconnect(): void }>();
  const stopped = new AbortController();
  // One queue per chain, so each chain waits out its own delay.
  const retakes = createAsyncTaskPool({ poolSize: 1 });

  function take(genesisHash: string): void {
    // A chain listed twice, or a re-take that finds the chain held again, builds nothing.
    if (leases.has(genesisHash)) {
      return;
    }
    const provider = pool.getLocalProvider(genesisHash, 'sync-observer');
    if (provider === null) {
      return;
    }
    leases.set(
      genesisHash,
      provider(
        () => {
          // The tap consumes its own responses before here, the rest is chatter nobody reads.
        },
        () => {
          leases.delete(genesisHash);
          retake(genesisHash);
        },
      ),
    );
  }

  function retake(genesisHash: string): void {
    void retakes
      .call(
        () => {
          take(genesisHash);
        },
        { pool: genesisHash, delay: retakeDelayMs, signal: stopped.signal },
      )
      .catch((error: unknown) => {
        // A stop cancels the waiting re-take, which is no failure.
        if (!stopped.signal.aborted) {
          reportRetake(error);
        }
      });
  }

  for (const genesisHash of genesisHashes) {
    take(genesisHash);
  }

  return () => {
    // Aborted first, so a re-take still waiting never opens a lease after the stop. A second stop finds nothing left.
    stopped.abort();
    for (const lease of [...leases.values()]) {
      lease.disconnect();
    }
    leases.clear();
  };
}
