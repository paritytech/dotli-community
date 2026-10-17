// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import type { SubscriptionHandler } from '@dotli/protocol';
import { deferred } from '@dotli/shared/testing';
import { createDeferredSubscription } from './deferred-subscription.js';
import { closeHostLinks, linkHost, record, type HostLink } from './testing/host-link.js';

afterEach(closeHostLinks);

/** A call the frame does not serve, whose answer means every leg sent before it has reached the frame. */
async function roundTrip(link: HostLink): Promise<void> {
  await expect(link.host.request('warmup', undefined)).rejects.toThrow('This end does not handle warmup');
}

/** Sends one byte total per subscription, and counts the subscriptions it started and stopped. */
function source(): { handler: SubscriptionHandler<'telemetry'>; started: () => number; stopped: Promise<void> } {
  let started = 0;
  const stopped = deferred<undefined>();
  return {
    handler: (_payload, _context, sink) => {
      started += 1;
      sink.send({ tag: 'netBytes', value: started });
      return () => {
        stopped.resolve(undefined);
      };
    },
    started: () => started,
    stopped: stopped.promise,
  };
}

describe('a subscription served before its source exists', () => {
  it('As the host, I subscribe while the frame boots and hear the source once it is there', async () => {
    // Given
    const link = linkHost();
    const telemetry = createDeferredSubscription<'telemetry'>();
    link.serving.handleSubscription('telemetry', telemetry.handler);
    const early = record(link.host, 'telemetry', undefined);
    await roundTrip(link);

    // When
    telemetry.serve(source().handler);
    const late = record(link.host, 'telemetry', undefined);

    // Then
    await early.until(1);
    await late.until(1);
    expect(early.events).toEqual([{ tag: 'netBytes', value: 1 }]);
    expect(late.events).toEqual([{ tag: 'netBytes', value: 2 }]);
  });

  it('As the host, a subscription I leave before the source is there never starts it', async () => {
    // Given
    const link = linkHost();
    const telemetry = createDeferredSubscription<'telemetry'>();
    link.serving.handleSubscription('telemetry', telemetry.handler);
    const early = record(link.host, 'telemetry', undefined);
    await roundTrip(link);

    // When
    early.unsubscribe();
    await roundTrip(link);
    const fed = source();
    telemetry.serve(fed.handler);

    // Then
    expect(fed.started()).toBe(0);
  });

  it('As the host, my unsubscribe after the source is there stops it', async () => {
    // Given
    const link = linkHost();
    const telemetry = createDeferredSubscription<'telemetry'>();
    link.serving.handleSubscription('telemetry', telemetry.handler);
    const fed = source();
    const heard = record(link.host, 'telemetry', undefined);
    await roundTrip(link);
    telemetry.serve(fed.handler);
    await heard.until(1);

    // When
    heard.unsubscribe();

    // Then
    await expect(fed.stopped).resolves.toBeUndefined();
  });

  it('As the host, a subscription waiting on a source that failed ends with its error, and so does a later one', async () => {
    // Given
    const link = linkHost();
    const telemetry = createDeferredSubscription<'telemetry'>();
    link.serving.handleSubscription('telemetry', telemetry.handler);
    const early = record(link.host, 'telemetry', undefined);
    await roundTrip(link);

    // When
    telemetry.fail(new Error('Unknown protocol mode: "nope"'));
    const fed = source();
    telemetry.serve(fed.handler);
    const late = record(link.host, 'telemetry', undefined);

    // Then the failure holds, and the source served after it is never started
    expect(await early.ended).toMatchObject({ message: 'Unknown protocol mode: "nope"' });
    expect(await late.ended).toMatchObject({ message: 'Unknown protocol mode: "nope"' });
    expect(early.events).toEqual([]);
    expect(fed.started()).toBe(0);
  });
});
