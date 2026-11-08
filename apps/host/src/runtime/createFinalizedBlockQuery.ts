// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A chain's finalized block height for the diagnostics report.

import { createReporter, defineCount } from '@dotli/metrics';
import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { isRemoteChainSupported } from '@dotli/protocol';
import { getErrorName, realTimers, setErrorName, withTimeout, type Timers } from '@dotli/shared';
import { loadHostBridge, loadPolkadotApi } from '../lazy.js';

const report = createReporter({ flow: 'ui' });

/**
 * One finalized height the diagnostics report asks a chain for. Tagged `outcome` (ok, error or timeout) and, on
 * failure, `reason`, as a failed one prints n/a.
 */
const diagnosticsFinalizedBlockMetric = defineCount<'error' | 'ok' | 'timeout'>('diagnostics.finalized_block');

export type FinalizedBlockClient = {
  /** Resolves with the chain's finalized block. Rejects when the chain does not answer. */
  getFinalizedBlock: () => Promise<{ number: number }>;
  /** Closes the client. Throws when the close fails. */
  destroy: () => void;
};

export type FinalizedBlockSource = {
  /**
   * The host's provider for the chain, or null when the active backend does not serve it. Rejects when the provider
   * fails to load.
   */
  provider: (genesisHash: string) => Promise<JsonRpcProvider | null>;
  /** Resolves with a client over `provider`. Rejects when the client fails to load. */
  createClient: (provider: JsonRpcProvider) => Promise<FinalizedBlockClient>;
};

type Params = {
  /** The clock and timers the query's limit runs on. The page's own by default. */
  timers?: Timers;
};

const FINALIZED_BLOCK_LIMIT_MS = 10_000;

/** Returns the query of a chain's finalized block height over `source`. Never throws. */
export function createFinalizedBlockQuery(source: FinalizedBlockSource, { timers = realTimers }: Params = {}) {
  /**
   * Null when the chain is not served, does not answer, or the query times out. Never rejects, and reports its own
   * failures.
   */
  async function readFinalizedBlockNumber(genesisHash: string): Promise<number | null> {
    const timeout = setErrorName(
      new Error(`No finalized block within ${String(FINALIZED_BLOCK_LIMIT_MS)}ms`),
      'TimeoutError',
    );
    try {
      const provider = await source.provider(genesisHash);
      if (provider === null) {
        return null;
      }
      const client = await source.createClient(provider);
      let block: { number: number };
      try {
        block = await withTimeout({
          work: client.getFinalizedBlock(),
          ms: FINALIZED_BLOCK_LIMIT_MS,
          timeoutError: () => timeout,
          timers,
        });
      } finally {
        client.destroy();
      }
      // After the close, so a close that throws counts as the one error instead of after an ok.
      diagnosticsFinalizedBlockMetric.count({ outcome: 'ok' });
      return block.number;
    } catch (error) {
      if (error === timeout) {
        // A slow chain is the network's state rather than a fault, and the report says n/a for it.
        report.expected(error, {
          step: 'diagnostics_block',
          metric: diagnosticsFinalizedBlockMetric,
          outcome: 'timeout',
          reason: 'timeout',
          message: '[dot.li diagnostics] finalized block query timed out:',
        });
      } else {
        const reason = getErrorName(error) ?? 'unknown';
        report.defect(error, {
          step: 'diagnostics_block',
          metric: diagnosticsFinalizedBlockMetric,
          message: '[dot.li diagnostics] finalized block query failed:',
          tags: { reason },
        });
      }
      return null;
    }
  }

  return readFinalizedBlockNumber;
}

/** The page's query, over the host's chains. The bridge and `polkadot-api` chunks load only once it is called. */
export const queryFinalizedBlock = createFinalizedBlockQuery({
  provider: async genesisHash =>
    isRemoteChainSupported(genesisHash) ? (await loadHostBridge()).getHostChainProvider(genesisHash) : null,
  createClient: async provider => (await loadPolkadotApi()).createClient(provider),
});
