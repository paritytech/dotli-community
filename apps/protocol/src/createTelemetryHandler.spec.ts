// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import type { ChainDetail, ChainSyncEvent, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import { protocolSchema } from '@dotli/protocol';
import { createDeferred } from '@dotli/shared';
import { err, hostFailure } from '@dotli/transport';
import { createTelemetryHandler, type TelemetryHandlerParams } from './createTelemetryHandler.js';
import { closeHostLinks, linkHost } from './testing/linkHost.js';
import { record } from './testing/record.js';

afterEach(closeHostLinks);

const { frame } = protocolSchema.sections;

type DbListener = (chain: SmoldotDbChain, outcome: SmoldotDbOutcome) => void;

type Params = {
  /** Replayed to each new chain sync listener. */
  sync?: ChainSyncEvent[];
  /** Replayed to each new chain detail listener. */
  details?: ChainDetail[];
  /** The database outcomes the light client read so far. */
  db?: [SmoldotDbChain, SmoldotDbOutcome][];
  /** The byte total each new byte listener hears at once. */
  bytes?: number;
  /** Whether the tab joined chains that had already synced. */
  joinedSynced?: boolean;
};

/** Feeds that replay what they hold to each new listener, as the chain sync reporter does. */
function createFeeds({ sync = [], details = [], db = [], bytes = 0, joinedSynced = false }: Params) {
  const dbListeners = new Set<DbListener>();
  let running = 0;
  const allStopped = createDeferred<undefined>();
  const params: TelemetryHandlerParams = {
    onChainSync(listener) {
      for (const event of sync) {
        listener(event);
      }
      return startFeed();
    },
    onChainDetail(listener) {
      for (const detail of details) {
        listener(detail);
      }
      return startFeed();
    },
    readDbOutcomes: () => new Map(db),
    onDbOutcome(listener) {
      dbListeners.add(listener);
      const stop = startFeed();
      return stopDbFeed;

      function stopDbFeed(): void {
        dbListeners.delete(listener);
        stop();
      }
    },
    onNetBytes(listener) {
      listener(bytes);
      return startFeed();
    },
    hasJoinedSynced: () => joinedSynced,
  };
  return {
    /** The feeds, as the handler takes them. */
    params,
    /** The light client reports a database read after the host subscribed. */
    readDb: (chain: SmoldotDbChain, outcome: SmoldotDbOutcome): void => {
      for (const listener of dbListeners) {
        listener(chain, outcome);
      }
    },
    /** Resolves once every feed was stopped. Never rejects. */
    stopped: allStopped.promise,
  };

  function startFeed(): () => void {
    running += 1;
    return stopFeed;
  }

  function stopFeed(): void {
    running -= 1;
    if (running === 0) {
      allStopped.resolve(undefined);
    }
  }
}

describe('the telemetry handler', () => {
  it("As the host, I subscribe late and hear each chain's latest state and every database outcome so far", async () => {
    // Given
    const link = linkHost();
    const { params, readDb } = createFeeds({
      sync: [{ chain: 'relay', kind: 'warpSyncProgress', at: 5, target: 10 }],
      details: [{ chain: 'relay', dbCache: 'miss' }],
      db: [
        ['relay', 'miss'],
        ['assethub', 'hit'],
      ],
      bytes: 4096,
    });
    link.serving.handleSubscription(frame.telemetry, createTelemetryHandler(params));

    // When
    const heard = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await heard.waitFor(5);
    readDb('bulletin', 'unavailable');
    await heard.waitFor(6);

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

  it('As a tab that joined synced chains, I subscribe and hear each database outcome as a hit', async () => {
    // Given
    const link = linkHost();
    const { params, readDb } = createFeeds({
      details: [{ chain: 'relay', dbCache: 'miss' }],
      db: [['relay', 'miss']],
      joinedSynced: true,
    });
    link.serving.handleSubscription(frame.telemetry, createTelemetryHandler(params));

    // When
    const heard = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await heard.waitFor(3);
    readDb('assethub', 'miss');
    await heard.waitFor(4);

    // Then the replay is a hit, while a read made after I joined is the light client's own
    expect(heard.events).toEqual([
      { tag: 'chainDetail', value: { chain: 'relay', dbCache: 'hit' } },
      { tag: 'smoldotDb', value: { chain: 'relay', outcome: 'hit' } },
      { tag: 'netBytes', value: 0 },
      { tag: 'smoldotDb', value: { chain: 'assethub', outcome: 'miss' } },
    ]);
  });

  it('As the host, I unsubscribe and every feed stops', async () => {
    // Given
    const link = linkHost();
    const { params, stopped } = createFeeds({});
    link.serving.handleSubscription(frame.telemetry, createTelemetryHandler(params));
    const heard = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await heard.waitFor(1);

    // When
    heard.unsubscribe();

    // Then
    await expect(stopped).resolves.toBeUndefined();
  });

  it('As the host, I subscribe while a feed fails to start and my subscription ends with its error while the feeds already started stop', async () => {
    // Given a byte meter that throws once the other feeds have started
    const link = linkHost();
    const { params, stopped } = createFeeds({});
    const broken = new Error('byte meter is gone');
    link.serving.handleSubscription(
      frame.telemetry,
      createTelemetryHandler({
        ...params,
        onNetBytes: () => {
          throw broken;
        },
      }),
    );

    // When
    const heard = record({ transport: link.host, method: frame.telemetry, start: undefined });

    // Then
    expect(await heard.ended).toEqual(err(hostFailure('Error: byte meter is gone')));
    await expect(stopped).resolves.toBeUndefined();
  });
});
