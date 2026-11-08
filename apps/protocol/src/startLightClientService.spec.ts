// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { NETWORK_NAME_TO_SERVICES_CONFIG } from '@dotli/config';
import type { LightClient } from '@dotli/chains';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createDeferred } from '@dotli/shared';
import { catchError, must, recordLog } from '@dotli/shared/testing';
import { startLightClientService, type LightClientResolver } from './startLightClientService.js';

type ResolverParams = Parameters<LightClientResolver['createDotnsResolver']>[0];

const SERVICES = NETWORK_NAME_TO_SERVICES_CONFIG['paseo-next-v2'];

/** Why the stub resolver's People warm fails. */
const PEOPLE_FAILURE = new Error('People did not sync');

/** A light client and resolver that record what the service opened, in order. */
function createFakes() {
  const events: string[] = [];
  let resolverParams: ResolverParams | null = null;
  const lightClient: LightClient = {
    createChainTransport(genesisHash) {
      events.push(`open ${genesisHash}`);
      return {
        provider: (): JsonRpcConnection => ({ send: () => undefined, disconnect: () => undefined }),
        followLimit: Infinity,
      };
    },
    isChainSupported: () => true,
    status: () => ({ fatal: null, db: new Map() }),
    subscribe: () => () => undefined,
  };
  const resolver: LightClientResolver = {
    enableSyncReporting: chains => {
      events.push(`report ${chains.join(',')}`);
    },
    createDotnsResolver(params) {
      resolverParams = params;
      // The service hands the resolver on and only warms People itself, so a stub with that one method is enough.
      return {
        waitForPeopleFinalized: () => Promise.reject(PEOPLE_FAILURE),
      } as ReturnType<LightClientResolver['createDotnsResolver']>;
    },
  };
  return {
    lightClient,
    resolver,
    events,
    readResolverParams: (): ResolverParams => must(resolverParams, 'resolver params'),
  };
}

describe('startLightClientService', () => {
  it('As a dotli user in either light client mode, I start the service and the relay and Bulletin sync shows before any product asks for them', () => {
    // Given
    const { lightClient, resolver, events } = createFakes();

    // When
    startLightClientService({ lightClient, resolver, services: SERVICES });

    // Then sync reporting is on before the first chain opens, which then carries its lifecycle watch
    expect(events).toEqual([
      'report relay,assethub,bulletin,people',
      `open ${SERVICES.relay.genesis}`,
      `open ${SERVICES.bulletin.genesis}`,
    ]);
  });

  it("As a dotli user in either light client mode, I resolve names and they read the light client's own Asset Hub and People", () => {
    // Given
    const { lightClient, resolver, events, readResolverParams } = createFakes();
    startLightClientService({ lightClient, resolver, services: SERVICES });

    // When
    readResolverParams().assetHub()(() => undefined);
    must(readResolverParams().people, 'people')()(() => undefined);

    // Then
    expect(events.slice(3)).toEqual([`open ${SERVICES.assethub.genesis}`, `open ${SERVICES.people.genesis}`]);
    expect(readResolverParams().dotns).toEqual(SERVICES.dotns);
  });

  it('As a dotli operator, I watch the People warm fail and see it logged and counted as an expected failure, while the start goes on', async () => {
    // Given a service whose People warm fails, with its reports recorded
    const { lightClient, resolver } = createFakes();
    const service = startLightClientService({ lightClient, resolver, services: SERVICES });
    const reported = createDeferred<{ error: unknown; step: string }>();
    onTestFinished(
      bindCaptureSink({
        exception: () => undefined,
        expected: (error, context) => {
          reported.resolve({ error, step: context.step });
        },
      }),
    );
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const warnings = recordLog({ onFinished: onTestFinished, level: 'warn' });

    // When
    const thrown = catchError(() => {
      service.warmPeople('[dot.li protocol]');
    });
    const report = await reported.promise;

    // Then
    expect(thrown).toBeUndefined();
    expect(report).toEqual({ error: PEOPLE_FAILURE, step: 'people_warm' });
    expect(metrics.counted('protocol.people_warm')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(warnings.map(line => line.args)).toEqual([
      ['[dot.li protocol] People chain warm failed (retried on demand)', PEOPLE_FAILURE],
    ]);
  });
});
