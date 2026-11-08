// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's chains and name resolver, set up the same whether smoldot runs in this iframe or in the
// SharedWorker. It opens no transport, and warms People only when asked.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import type { ChainRole, FixedServicesConfig } from '@dotli/config/fixed';
import { createChainPool, requireBrokerLocalProvider } from '@dotli/chains';
import { createReporter, defineCount } from '@dotli/metrics';

import { observeChains } from './observeChains.js';

const report = createReporter({ flow: 'protocol' });

/**
 * The People chain the protocol frame or its SharedWorker warms in the background failed to sync, so the first read of
 * People waits on it instead. Tagged `outcome` (error) and `reason` (the error's name).
 */
const protocolPeopleWarmMetric = defineCount<'error'>('protocol.people_warm');

export type LightClientResolver = Pick<typeof Resolver, 'createDotnsResolver'> &
  Pick<typeof Chains.chainSync, 'enableSyncReporting'>;

type Params = {
  /** The light client whose chains the service opens. */
  lightClient: Chains.LightClient;
  /** The name resolver's factory and the sync reporting. */
  resolver: LightClientResolver;
  /** The chains and the name contracts of the network the service runs on. */
  services: FixedServicesConfig;
};

/** The light client's chains and name resolver. */
export type LightClientService = ReturnType<typeof startLightClientService>;

/** The chains the load waits on, in that order, then People. */
const REPORTED_CHAINS: readonly ChainRole[] = ['relay', 'assethub', 'bulletin', 'people'];

/** Opens the chain pool on `lightClient`, watches the relay and Bulletin, and builds the name resolver. */
export function startLightClientService({ lightClient, resolver, services }: Params) {
  // Before the first chain opens, or that connection carries no lifecycle watch.
  resolver.enableSyncReporting(REPORTED_CHAINS);
  // Releasing a smoldot chain makes the light client drop it and re-sync later.
  const pool = createChainPool({
    createTransport: lightClient.createChainTransport,
    destroyDelay: Infinity,
  });
  // The relay carries the warp progress but papi never dials it. Bulletin opened lazily by the first `bitswap_v1_get`
  // has no peers yet and fails it, so it finds peers while the name resolves.
  const releaseChains = observeChains({ pool, genesisHashes: [services.relay.genesis, services.bulletin.genesis] });
  // The resolver reads through leases on the same pool as every dApp, so a dApp leaving never ends the resolver's
  // follow. A separate resolver chain would be released by the first dApp connection mid-read (`ChainHead disjointed`).
  const dotns = resolver.createDotnsResolver({
    assetHub: () =>
      requireBrokerLocalProvider({ manager: pool, genesisHash: services.assethub.genesis, label: 'Asset Hub' }),
    people: () => requireBrokerLocalProvider({ manager: pool, genesisHash: services.people.genesis, label: 'People' }),
    dotns: services.dotns,
    source: 'light-client',
  });
  return {
    /** The chains every engine scope connects to. */
    pool,
    /** Resolves names through the pool's broker follows. */
    dotns,
    /** Lets go of the observed chains. May run more than once. Throws what a chain lease's disconnect throws. */
    dispose: releaseChains,
    /**
     * Starts People syncing in the background, so a later read of it does not race a cold warp sync, and returns at
     * once. A warm that fails is logged under `logTag` and counted as an expected failure, since a read retries it.
     * Never throws.
     */
    warmPeople,
  };

  function warmPeople(logTag: string): void {
    void dotns.waitForPeopleFinalized().catch((error: unknown) => {
      report.expected(error, {
        step: 'people_warm',
        metric: protocolPeopleWarmMetric,
        message: `${logTag} People chain warm failed (retried on demand)`,
      });
    });
  }
}
