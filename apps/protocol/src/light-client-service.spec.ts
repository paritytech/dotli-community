// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import type { LightClient } from '@dotli/chains';
import { must } from '@dotli/shared/testing';
import { startLightClientService, type LightClientResolver } from './light-client-service.js';

const services = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'];

type ResolverDeps = Parameters<LightClientResolver['createDotnsResolver']>[0];

/** A light client and resolver that record what the service opened, in order. */
function fakes() {
  const events: string[] = [];
  let resolverDeps: ResolverDeps | null = null;
  const lightClient: LightClient = {
    createChainProvider: genesisHash => {
      events.push(`open ${genesisHash}`);
      return (): JsonRpcConnection => ({ send: () => undefined, disconnect: () => undefined });
    },
    isChainSupported: () => true,
    status: () => ({ fatal: null, db: new Map() }),
    subscribe: () => () => undefined,
  };
  const resolver: LightClientResolver = {
    enableSyncReporting: chains => {
      events.push(`report ${chains.join(',')}`);
    },
    createDotnsResolver: deps => {
      resolverDeps = deps;
      return {} as ReturnType<LightClientResolver['createDotnsResolver']>;
    },
  };
  return { lightClient, resolver, events, resolverDeps: () => must(resolverDeps, 'resolver deps') };
}

describe('startLightClientService', () => {
  it('As a dotli user in either light client mode, the relay and Bulletin sync shows before any product asks for them', () => {
    // Given
    const { lightClient, resolver, events } = fakes();

    // When
    startLightClientService({ lightClient, resolver, services });

    // Then sync reporting is on before the first chain opens, which then carries its lifecycle watch
    expect(events).toEqual([
      'report relay,assethub,bulletin,people',
      `open ${services.relay.genesis}`,
      `open ${services.bulletin.genesis}`,
    ]);
  });

  it("As a dotli user in either light client mode, names resolve over the light client's own Asset Hub and People follows", () => {
    // Given
    const { lightClient, resolver, events, resolverDeps } = fakes();
    startLightClientService({ lightClient, resolver, services });

    // When
    resolverDeps().assetHub()(() => undefined);
    must(resolverDeps().people, 'people')()(() => undefined);

    // Then
    expect(events.slice(3)).toEqual([`open ${services.assethub.genesis}`, `open ${services.people.genesis}`]);
    expect(resolverDeps().dotns).toEqual(services.dotns);
  });
});
