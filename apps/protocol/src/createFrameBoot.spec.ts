// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolInitFailedError, protocolSchema, type ProtocolContext, type ProtocolHandler } from '@dotli/protocol';
import { domain, err, hostFailure } from '@dotli/transport';
import { createFrameBoot } from './createFrameBoot.js';
import { closeHostLinks, linkHost } from './testing/linkHost.js';
import { record, type EndOf } from './testing/record.js';
import { roundTrip } from './testing/roundTrip.js';

afterEach(closeHostLinks);

const { frame } = protocolSchema.sections;

/** A host linked to a booting frame, subscribed to its status and telemetry at once, as the host does. */
function bootFrame() {
  const boot = createFrameBoot();
  const link = linkHost();
  link.serving.handleSubscription(frame.status, boot.handleStatus);
  link.serving.handleSubscription(frame.telemetry, boot.handleTelemetry);
  return {
    /** The frame's boot under test. */
    boot,
    /** The host's link to the frame. */
    link,
  };
}

/** Whether the recorded subscription has ended by now. */
function watchEnded(ended: Promise<EndOf<undefined>>): () => boolean {
  let over = false;
  void ended.then(() => {
    over = true;
  });
  return () => over;
}

/** A telemetry source that sends one byte total and never ends. */
function sendBytes(
  _start: undefined,
  _context: ProtocolContext,
  sink: Parameters<ProtocolHandler<typeof frame.telemetry>>[2],
): () => void {
  sink.send({ tag: 'netBytes', value: 4_096 });
  return () => undefined;
}

describe('the frame boot', () => {
  it('As the host of a frame with no light client of its own, I subscribe while it boots and my telemetry opens silent once it is ready', async () => {
    // Given a host that subscribed while the frame booted
    const { boot, link } = bootFrame();
    const status = record({ transport: link.host, method: frame.status, start: undefined });
    const telemetry = record({ transport: link.host, method: frame.telemetry, start: undefined });
    const over = watchEnded(telemetry.ended);
    await roundTrip(link);

    // When an auth-only or gateway frame becomes ready without a telemetry source
    boot.markReady();
    await status.waitFor(1);
    await roundTrip(link);

    // Then the telemetry is open and silent
    expect(over()).toBe(false);
    expect(telemetry.events).toEqual([]);
  });

  it('As the host of a frame with no light client of its own, I watch it stop for good and my silent telemetry stays open', async () => {
    // Given a host that subscribed while the frame booted, and a frame that became ready without a telemetry source
    const { boot, link } = bootFrame();
    const status = record({ transport: link.host, method: frame.status, start: undefined });
    const telemetry = record({ transport: link.host, method: frame.telemetry, start: undefined });
    const over = watchEnded(telemetry.ended);
    await roundTrip(link);
    boot.markReady();
    await status.waitFor(1);

    // When the frame later stops for good
    boot.fail(new Error('frame stopped'));
    await status.ended;
    await roundTrip(link);

    // Then the telemetry was served, not left waiting, so it stays open
    expect(over()).toBe(false);
  });

  it('As the host of a light client frame, I subscribe before and after ready and hear the telemetry its mode serves', async () => {
    // Given
    const { boot, link } = bootFrame();
    const early = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await roundTrip(link);

    // When the mode serves its feed while it syncs, then becomes ready
    boot.serveTelemetry(sendBytes);
    boot.markReady();
    const late = record({ transport: link.host, method: frame.telemetry, start: undefined });

    // Then both subscriptions hear the feed
    await early.waitFor(1);
    await late.waitFor(1);
    expect(early.events).toEqual([{ tag: 'netBytes', value: 4_096 }]);
    expect(late.events).toEqual([{ tag: 'netBytes', value: 4_096 }]);
  });

  it('As the host of a frame whose boot failed, I subscribe and my status and telemetry end with the failure, as does a later one', async () => {
    // Given
    const { boot, link } = bootFrame();
    const status = record({ transport: link.host, method: frame.status, start: undefined });
    const early = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await roundTrip(link);

    // When
    boot.fail(new ProtocolInitFailedError('Unknown protocol mode: "nope"'));
    const late = record({ transport: link.host, method: frame.telemetry, start: undefined });

    // Then the status ends typed, and the telemetry, which has no failure of its own, ends with the error's name
    expect(await status.ended).toEqual(err(domain({ tag: 'initFailed', value: 'Unknown protocol mode: "nope"' })));
    const failure = err(hostFailure('ProtocolInitFailedError: Unknown protocol mode: "nope"'));
    expect(await early.ended).toEqual(failure);
    expect(await late.ended).toEqual(failure);
  });

  it('As the host of a ready frame that later dies, I watch it die and my status ends while my telemetry keeps its source', async () => {
    // Given
    const { boot, link } = bootFrame();
    boot.serveTelemetry(sendBytes);
    boot.markReady();
    const status = record({ transport: link.host, method: frame.status, start: undefined });
    const telemetry = record({ transport: link.host, method: frame.telemetry, start: undefined });
    await status.waitFor(1);
    await telemetry.waitFor(1);
    const over = watchEnded(telemetry.ended);

    // When
    boot.fail(new Error('light client died'));
    await roundTrip(link);

    // Then
    expect(await status.ended).toEqual(err(hostFailure('Error: light client died')));
    expect(over()).toBe(false);
  });
});
