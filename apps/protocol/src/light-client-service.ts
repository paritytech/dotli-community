// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client's chains and name resolver, set up the same whether smoldot runs in this iframe or in the
// SharedWorker. The caller owns the transport: how sync events reach its tabs, how requests reach the engine, and when
// People warms.

import type * as Chains from '@dotli/chains';
import type * as Resolver from '@dotli/resolver';
import type { ChainRole, FixedServicesConfig } from '@dotli/config';
import { createChainPool, requireBrokerLocalProvider, type ChainPool } from '@dotli/chains';
import type { DotnsResolver } from '@dotli/resolver';
import { observeChains } from './observe-chains.js';

/** The chains the load waits on, in that order, then People, whose peer count the network panel lists. */
const REPORTED_CHAINS: readonly ChainRole[] = ['relay', 'assethub', 'bulletin', 'people'];

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
  broker: ChainPool;
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
  const broker = createChainPool({ createTransport: lightClient.createChainProvider, destroyDelay: Infinity });
  // The relay carries the warp progress but papi never dials it. Bulletin opened lazily by the first `bitswap_v1_get`
  // has no peers yet and fails it, so it finds peers while the name resolves.
  const stop = observeChains(broker, [services.relay.genesis, services.bulletin.genesis]);
  // Through the broker's follows, since a second follow on one smoldot chain shares its one response queue, so the
  // broker would drop its events and reads would hang. A separate resolver chain would also be released by the first
  // dApp connection mid-read (`ChainHead disjointed`).
  const dotns = resolver.createDotnsResolver({
    assetHub: () => requireBrokerLocalProvider(broker, services.assethub.genesis, 'Asset Hub'),
    people: () => requireBrokerLocalProvider(broker, services.people.genesis, 'People'),
    dotns: services.dotns,
    source: 'light-client',
  });
  return { broker, dotns, stop };
}
