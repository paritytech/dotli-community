// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolInitFailedError, protocolSchema, type ProtocolHandler } from '@dotli/protocol';
import { deferred } from '@dotli/shared';
import { domain, err, hostFailure, type MethodTypes } from '@dotli/transport';
import {
  createDeferredSubscription,
  createFrameBoot,
  type DeferredSubscription,
  type FrameBoot,
} from './frame-boot.js';
import { closeHostLinks, linkHost, record, roundTrip, type EndOf, type HostLink } from './testing/host-link.js';

afterEach(closeHostLinks);

const { frame } = protocolSchema.sections;

/** A host linked to a booting frame, subscribed to its status and telemetry at once, as the host does. */
function setup(): { boot: FrameBoot; link: HostLink } {
  const boot = createFrameBoot();
  const link = linkHost();
  link.serving.handleSubscription(frame.status, boot.frameStatus);
  link.serving.handleSubscription(frame.telemetry, boot.telemetry);
  return { boot, link };
}

/** Whether the recorded subscription has ended by now. */
function endedYet(ended: Promise<EndOf<undefined>>): () => boolean {
  let over = false;
  void ended.then(() => {
    over = true;
  });
  return () => over;
}

const bytes: ProtocolHandler<typeof frame.telemetry> = (_start, _context, sink) => {
  sink.send({ tag: 'netBytes', value: 4_096 });
  return () => undefined;
};

describe('the frame boot', () => {
  it('As the host of a frame with no light client of its own, my telemetry opens silent once the frame is ready', async () => {
    // Given a host that subscribed while the frame booted
    const { boot, link } = setup();
    const status = record(link.host, frame.status, undefined);
    const telemetry = record(link.host, frame.telemetry, undefined);
    const over = endedYet(telemetry.ended);
    await roundTrip(link);

    // When an auth-only or gateway frame becomes ready without a telemetry source
    boot.ready();
    await status.until(1);
    await roundTrip(link);

    // Then the telemetry is open and silent
    expect(over()).toBe(false);
    expect(telemetry.events).toEqual([]);

    // When the frame later stops for good
    boot.fail(new Error('frame stopped'));
    await status.ended;
    await roundTrip(link);

    // Then the telemetry was served, not left waiting, so it stays open
    expect(over()).toBe(false);
  });

  it('As the host of a light client frame, I hear the telemetry its mode serves, before and after ready', async () => {
    // Given
    const { boot, link } = setup();
    const early = record(link.host, frame.telemetry, undefined);
    await roundTrip(link);

    // When the mode serves its feed while it syncs, then becomes ready
    boot.serveTelemetry(bytes);
    boot.ready();
    const late = record(link.host, frame.telemetry, undefined);

    // Then both subscriptions hear the feed
    await early.until(1);
    await late.until(1);
    expect(early.events).toEqual([{ tag: 'netBytes', value: 4_096 }]);
    expect(late.events).toEqual([{ tag: 'netBytes', value: 4_096 }]);
  });

  it('As the host of a frame whose boot failed, my status and telemetry end with the failure, and so does a later one', async () => {
    // Given
    const { boot, link } = setup();
    const status = record(link.host, frame.status, undefined);
    const early = record(link.host, frame.telemetry, undefined);
    await roundTrip(link);

    // When
    boot.fail(new ProtocolInitFailedError('Unknown protocol mode: "nope"'));
    const late = record(link.host, frame.telemetry, undefined);

    // Then the status ends typed, and the telemetry, which has no failure of its own, ends with the error's name
    expect(await status.ended).toEqual(err(domain({ tag: 'initFailed', value: 'Unknown protocol mode: "nope"' })));
    const failure = err(hostFailure('ProtocolInitFailedError: Unknown protocol mode: "nope"'));
    expect(await early.ended).toEqual(failure);
    expect(await late.ended).toEqual(failure);
  });

  it('As the host of a ready frame that later dies, my status ends and my telemetry keeps its source', async () => {
    // Given
    const { boot, link } = setup();
    boot.serveTelemetry(bytes);
    boot.ready();
    const status = record(link.host, frame.status, undefined);
    const telemetry = record(link.host, frame.telemetry, undefined);
    await status.until(1);
    await telemetry.until(1);
    const over = endedYet(telemetry.ended);

    // When
    boot.fail(new Error('light client died'));
    await roundTrip(link);

    // Then
    expect(await status.ended).toEqual(err(hostFailure('Error: light client died')));
    expect(over()).toBe(false);
  });
});

type Telemetry = MethodTypes<typeof frame.telemetry>;
type TelemetryHandler = ProtocolHandler<typeof frame.telemetry>;
type DeferredTelemetry = DeferredSubscription<Telemetry['start'], Telemetry['receive'], undefined>;

/** A deferred telemetry the frame serves on `link`. */
function telemetrySubscription(link: HostLink): DeferredTelemetry {
  const telemetry: DeferredTelemetry = createDeferredSubscription();
  link.serving.handleSubscription(frame.telemetry, telemetry.handler);
  return telemetry;
}

/** Sends one byte total per subscription, and counts the subscriptions it started and stopped. */
function source(): { handler: TelemetryHandler; started: () => number; stopped: Promise<void> } {
  let started = 0;
  const stopped = deferred<undefined>();
  return {
    handler: (_start, _context, sink) => {
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
    const telemetry = telemetrySubscription(link);
    const early = record(link.host, frame.telemetry, undefined);
    await roundTrip(link);

    // When
    telemetry.serve(source().handler);
    const late = record(link.host, frame.telemetry, undefined);

    // Then
    await early.until(1);
    await late.until(1);
    expect(early.events).toEqual([{ tag: 'netBytes', value: 1 }]);
    expect(late.events).toEqual([{ tag: 'netBytes', value: 2 }]);
  });

  it('As the host, a subscription I leave before the source is there never starts it', async () => {
    // Given
    const link = linkHost();
    const telemetry = telemetrySubscription(link);
    const early = record(link.host, frame.telemetry, undefined);
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
    const telemetry = telemetrySubscription(link);
    const fed = source();
    const heard = record(link.host, frame.telemetry, undefined);
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
    const telemetry = telemetrySubscription(link);
    const early = record(link.host, frame.telemetry, undefined);
    await roundTrip(link);

    // When
    telemetry.fail(new Error('Unknown protocol mode: "nope"'));
    const fed = source();
    telemetry.serve(fed.handler);
    const late = record(link.host, frame.telemetry, undefined);

    // Then the failure holds, and the source served after it is never started
    const failure = err(hostFailure('Error: Unknown protocol mode: "nope"'));
    expect(await early.ended).toEqual(failure);
    expect(await late.ended).toEqual(failure);
    expect(early.events).toEqual([]);
    expect(fed.started()).toBe(0);
  });
});
