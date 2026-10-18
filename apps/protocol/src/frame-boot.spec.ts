// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolInitFailedError, type ProtocolSchema } from '@dotli/protocol';
import { domain, err, hostFailure, unsupported, type SubscriptionHandler } from '@dotli/transport';
import { createFrameBoot, type FrameBoot } from './frame-boot.js';
import { closeHostLinks, linkHost, record, type EndOf, type HostLink } from './testing/host-link.js';

afterEach(closeHostLinks);

/** A host linked to a booting frame, subscribed to its status and telemetry at once, as the host does. */
function setup(): { boot: FrameBoot; link: HostLink } {
  const boot = createFrameBoot();
  const link = linkHost();
  link.serving.handleSubscription('frame', 'status', boot.frameStatus);
  link.serving.handleSubscription('frame', 'telemetry', boot.telemetry);
  return { boot, link };
}

/** A call the frame does not serve, whose answer means every call sent before it has come back. */
async function roundTrip(link: HostLink): Promise<void> {
  await expect(link.host.request('frame', 'warmup', undefined)).resolves.toEqual(err(unsupported()));
}

/** Whether the recorded subscription has ended by now. */
function endedYet(ended: Promise<EndOf<'frame', 'telemetry'>>): () => boolean {
  let over = false;
  void ended.then(() => {
    over = true;
  });
  return () => over;
}

const bytes: SubscriptionHandler<ProtocolSchema, 'frame', 'telemetry'> = (_start, _context, sink) => {
  sink.receive({ tag: 'netBytes', value: 4_096 });
  return () => undefined;
};

describe('the frame boot', () => {
  it('As the host of a frame with no light client of its own, my telemetry opens silent once the frame is ready', async () => {
    // Given a host that subscribed while the frame booted
    const { boot, link } = setup();
    const status = record(link.host, 'frame', 'status', undefined);
    const telemetry = record(link.host, 'frame', 'telemetry', undefined);
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
    const early = record(link.host, 'frame', 'telemetry', undefined);
    await roundTrip(link);

    // When the mode serves its feed while it syncs, then becomes ready
    boot.serveTelemetry(bytes);
    boot.ready();
    const late = record(link.host, 'frame', 'telemetry', undefined);

    // Then both subscriptions hear the feed
    await early.until(1);
    await late.until(1);
    expect(early.events).toEqual([{ tag: 'netBytes', value: 4_096 }]);
    expect(late.events).toEqual([{ tag: 'netBytes', value: 4_096 }]);
  });

  it('As the host of a frame whose boot failed, my status and telemetry end with the failure, and so does a later one', async () => {
    // Given
    const { boot, link } = setup();
    const status = record(link.host, 'frame', 'status', undefined);
    const early = record(link.host, 'frame', 'telemetry', undefined);
    await roundTrip(link);

    // When
    boot.fail(new ProtocolInitFailedError('Unknown protocol mode: "nope"'));
    const late = record(link.host, 'frame', 'telemetry', undefined);

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
    const status = record(link.host, 'frame', 'status', undefined);
    const telemetry = record(link.host, 'frame', 'telemetry', undefined);
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
