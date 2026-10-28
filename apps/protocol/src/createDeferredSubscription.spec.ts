// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { protocolSchema, type ProtocolContext, type ProtocolHandler } from '@dotli/protocol';
import { createDeferred } from '@dotli/shared';
import { err, hostFailure, type MethodTypes } from '@dotli/transport';
import { createDeferredSubscription, type DeferredSubscription } from './createDeferredSubscription.js';
import { closeHostLinks, linkHost, type HostLink } from './testing/linkHost.js';
import { record } from './testing/record.js';
import { roundTrip } from './testing/roundTrip.js';

afterEach(closeHostLinks);

const { frame } = protocolSchema.sections;

type Telemetry = MethodTypes<typeof frame.telemetry>;
type TelemetrySink = Parameters<ProtocolHandler<typeof frame.telemetry>>[2];
type DeferredTelemetry = DeferredSubscription<Telemetry['start'], Telemetry['receive'], undefined>;

/** A deferred telemetry the frame serves on `link`. */
function serveDeferredTelemetry(link: HostLink): DeferredTelemetry {
  const telemetry: DeferredTelemetry = createDeferredSubscription();
  link.serving.handleSubscription(frame.telemetry, telemetry.accept);
  return telemetry;
}

/** Sends one byte total per subscription, and counts the subscriptions it started and stopped. */
function createSource() {
  let started = 0;
  const stopped = createDeferred<undefined>();
  return {
    /** Starts one subscription, which hears the count of subscriptions started so far. Never throws. */
    start,
    /** How many subscriptions it started. Never throws. */
    countStarted: (): number => started,
    /** Settles once a subscription it started was stopped. Never rejects. */
    stopped: stopped.promise,
  };

  function start(_start: Telemetry['start'], _context: ProtocolContext, sink: TelemetrySink): () => void {
    started += 1;
    sink.send({ tag: 'netBytes', value: started });
    return () => {
      stopped.resolve(undefined);
    };
  }
}

describe('a subscription served before its source exists', () => {
  it('As the host, I subscribe while the frame boots and hear the source once it is there', async () => {
    // Given
    const link = linkHost();
    const telemetry = serveDeferredTelemetry(link);
    const early = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await roundTrip(link);

    // When
    telemetry.serve(createSource().start);
    const late = record({ transport: link.host, method: frame.telemetry, start: undefined });

    // Then
    await early.waitFor(1);
    await late.waitFor(1);
    expect(early.events).toEqual([{ tag: 'netBytes', value: 1 }]);
    expect(late.events).toEqual([{ tag: 'netBytes', value: 2 }]);
  });

  it('As the host, I leave a subscription before the source is there and the source never starts', async () => {
    // Given
    const link = linkHost();
    const telemetry = serveDeferredTelemetry(link);
    const early = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await roundTrip(link);

    // When
    early.unsubscribe();
    await roundTrip(link);
    const fed = createSource();
    telemetry.serve(fed.start);

    // Then
    expect(fed.countStarted()).toBe(0);
  });

  it('As the host, I unsubscribe after the source is there and the source stops', async () => {
    // Given
    const link = linkHost();
    const telemetry = serveDeferredTelemetry(link);
    const fed = createSource();
    const heard = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await roundTrip(link);
    telemetry.serve(fed.start);
    await heard.waitFor(1);

    // When
    heard.unsubscribe();

    // Then
    await expect(fed.stopped).resolves.toBeUndefined();
  });

  it('As the host, I wait on a source that failed and my subscription ends with its error, as does a later one', async () => {
    // Given
    const link = linkHost();
    const telemetry = serveDeferredTelemetry(link);
    const early = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await roundTrip(link);

    // When
    telemetry.fail(new Error('Unknown protocol mode: "nope"'));
    const fed = createSource();
    telemetry.serve(fed.start);
    const late = record({ transport: link.host, method: frame.telemetry, start: undefined });

    // Then the failure holds, and the source served after it is never started
    const failure = err(hostFailure('Error: Unknown protocol mode: "nope"'));
    expect(await early.ended).toEqual(failure);
    expect(await late.ended).toEqual(failure);
    expect(early.events).toEqual([]);
    expect(fed.countStarted()).toBe(0);
  });
});
