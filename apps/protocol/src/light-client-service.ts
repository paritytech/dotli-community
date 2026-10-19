// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's chains and name resolver, set up the same whether smoldot runs in this iframe or in the
// SharedWorker. The caller owns the transport: how sync events reach its tabs, how requests reach the engine, and when
// People warms.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import type { ChainRole, FixedServicesConfig } from '@dotli/config/fixed';
import { createChainPool, requireBrokerLocalProvider, type ChainPool } from '@dotli/chains';
import { reportListener } from '@dotli/metrics';
import type { DotnsResolver } from '@dotli/resolver';
import { createAsyncTaskPool } from '@dotli/shared';

/** The chains the load waits on, in that order, then People, whose peer count the network panel lists. */
const REPORTED_CHAINS: readonly ChainRole[] = ['relay', 'assethub', 'bulletin', 'people'];

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

export type LightClientResolver = Pick<typeof Resolver, 'createDotnsResolver'> &
  Pick<typeof Chains, 'enableSyncReporting'>;

export interface LightClientServiceDeps {
  lightClient: Chains.LightClient;
  resolver: LightClientResolver;
  /** The SharedWorker passes the fixed config, since the runtime network config never reaches it. */
  services: FixedServicesConfig;
}

export interface LightClientService {
  /** The chains every engine scope connects to. */
  pool: ChainPool;
  dotns: DotnsResolver;
  /** Lets go of the observed chains. */
  stop: () => void;
}

export function startLightClientService({
  lightClient,
  resolver,
  services,
}: LightClientServiceDeps): LightClientService {
  // Before the first chain opens, or that connection carries no lifecycle watch.
  resolver.enableSyncReporting(REPORTED_CHAINS);
  // Releasing a smoldot chain makes the light client drop it and re-sync later.
  const pool = createChainPool({ createTransport: lightClient.createChainProvider, destroyDelay: Infinity });
  // The relay carries the warp progress but papi never dials it. Bulletin opened lazily by the first `bitswap_v1_get`
  // has no peers yet and fails it, so it finds peers while the name resolves.
  const stop = observeChains(pool, [services.relay.genesis, services.bulletin.genesis]);
  // Through the broker's follows, since a second follow on one smoldot chain shares its one response queue, so the
  // broker would drop its events and reads would hang. A separate resolver chain would also be released by the first
  // dApp connection mid-read (`ChainHead disjointed`).
  const dotns = resolver.createDotnsResolver({
    assetHub: () => requireBrokerLocalProvider(pool, services.assethub.genesis, 'Asset Hub'),
    people: () => requireBrokerLocalProvider(pool, services.people.genesis, 'People'),
    dotns: services.dotns,
    source: 'light-client',
  });
  return { pool, dotns, stop };
}
