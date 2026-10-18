// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import type { ChainDetail, ChainSyncEvent, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import { protocolSchema } from '@dotli/protocol';
import { deferred } from '@dotli/shared';
import { err, hostFailure } from '@dotli/transport';
import { createTelemetryHandler, type TelemetryDeps } from './telemetry-handler.js';
import { closeHostLinks, linkHost, record } from './testing/host-link.js';

afterEach(closeHostLinks);

const { frame } = protocolSchema.traits;

type DbListener = (chain: SmoldotDbChain, outcome: SmoldotDbOutcome) => void;

interface Sources {
  deps: TelemetryDeps;
  /** A database read the light client reports after the host subscribed. */
  readDb: (chain: SmoldotDbChain, outcome: SmoldotDbOutcome) => void;
  /** Resolves once every feed was stopped. */
  stopped: Promise<void>;
}

/** Feeds that replay what they hold to each new listener, as the chain sync reporter does. */
function sources(options: {
  sync?: ChainSyncEvent[];
  details?: ChainDetail[];
  db?: [SmoldotDbChain, SmoldotDbOutcome][];
  bytes?: number;
  joinedSynced?: boolean;
}): Sources {
  const dbListeners = new Set<DbListener>();
  let running = 0;
  const allStopped = deferred<undefined>();
  const feed = (): (() => void) => {
    running += 1;
    return () => {
      running -= 1;
      if (running === 0) {
        allStopped.resolve(undefined);
      }
    };
  };
  return {
    deps: {
      onChainSync: listener => {
        options.sync?.forEach(listener);
        return feed();
      },
      onChainDetail: listener => {
        options.details?.forEach(listener);
        return feed();
      },
      dbOutcomes: () => new Map(options.db ?? []),
      onDbOutcome: listener => {
        dbListeners.add(listener);
        const stop = feed();
        return () => {
          dbListeners.delete(listener);
          stop();
        };
      },
      netBytes: listener => {
        listener(options.bytes ?? 0);
        return feed();
      },
      joinedSynced: () => options.joinedSynced ?? false,
    },
    readDb: (chain, outcome) => {
      for (const listener of dbListeners) {
        listener(chain, outcome);
      }
    },
    stopped: allStopped.promise,
  };
}

describe('the telemetry handler', () => {
  it("As the host, I subscribe late and hear each chain's latest state and every database outcome so far", async () => {
    // Given
    const link = linkHost();
    const { deps, readDb } = sources({
      sync: [{ chain: 'relay', kind: 'warpSyncProgress', at: 5, target: 10 }],
      details: [{ chain: 'relay', dbCache: 'miss' }],
      db: [
        ['relay', 'miss'],
        ['assethub', 'hit'],
      ],
      bytes: 4096,
    });
    link.serving.handleSubscription(frame.telemetry, createTelemetryHandler(deps));

    // When
    const heard = record(link.host, frame.telemetry, undefined);
    await heard.until(5);
    readDb('bulletin', 'unavailable');
    await heard.until(6);

    // Then
    expect(heard.events).toEqual([
      { tag: 'chainSync', value: { chain: 'relay', kind: 'warpSyncProgress', at: 5, target: 10 } },
      { tag: 'chainDetail', value: { chain: 'relay', dbCache: 'miss' } },
      { tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } },
      { tag: 'smoldotDb', value: { chain: 'assethub', outcome: 'hit' } },
      { tag: 'netBytes', value: 4096 },
      { tag: 'smoldotDb', value: { chain: 'bulletin', outcome: 'unavailable' } },
    ]);
  });

  it('As a tab that joined synced chains, I hear each database outcome as a hit', async () => {
    // Given
    const link = linkHost();
    const { deps, readDb } = sources({
      details: [{ chain: 'relay', dbCache: 'miss' }],
      db: [['relay', 'miss']],
      joinedSynced: true,
    });
    link.serving.handleSubscription(frame.telemetry, createTelemetryHandler(deps));

    // When
    const heard = record(link.host, frame.telemetry, undefined);
    await heard.until(3);
    readDb('assethub', 'miss');
    await heard.until(4);

    // Then the replay is a hit, while a read made after I joined is the light client's own
    expect(heard.events).toEqual([
      { tag: 'chainDetail', value: { chain: 'relay', dbCache: 'hit' } },
      { tag: 'smoldotDb', value: { chain: 'relay', outcome: 'hit' } },
      { tag: 'netBytes', value: 0 },
      { tag: 'smoldotDb', value: { chain: 'assethub', outcome: 'miss' } },
    ]);
  });

  it('As the host, my unsubscribe stops every feed', async () => {
    // Given
    const link = linkHost();
    const { deps, stopped } = sources({});
    link.serving.handleSubscription(frame.telemetry, createTelemetryHandler(deps));
    const heard = record(link.host, frame.telemetry, undefined);
    await heard.until(1);

    // When
    heard.unsubscribe();

    // Then
    await expect(stopped).resolves.toBeUndefined();
  });

  it('As the host, a feed that fails to start ends my subscription with its error and stops the feeds already started', async () => {
    // Given a byte meter that throws once the other feeds have started
    const link = linkHost();
    const { deps, stopped } = sources({});
    const broken = new Error('byte meter is gone');
    link.serving.handleSubscription(
      frame.telemetry,
      createTelemetryHandler({
        ...deps,
        netBytes: () => {
          throw broken;
        },
      }),
    );

    // When
    const heard = record(link.host, frame.telemetry, undefined);

    // Then
    expect(await heard.ended).toEqual(err(hostFailure('Error: byte meter is gone')));
    await expect(stopped).resolves.toBeUndefined();
  });
});
