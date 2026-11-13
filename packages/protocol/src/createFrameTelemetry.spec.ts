// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import type { ChainDetail, ChainSyncEvent } from '@dotli/chains';
import { createManualTimers, type ManualTimers } from '@dotli/shared/testing';
import { ok, type Sink } from '@dotli/transport';
import { createFrameTelemetry } from './createFrameTelemetry.js';
import { createFakeFrame } from './createProtocolFrame.fake.js';
import type { TelemetryEvent } from './codecValues.js';
import { protocolSchema, type ProtocolTransport, type SubscriptionEnd } from './schema.js';

const { frame } = protocolSchema.sections;

type TelemetrySink = Sink<TelemetryEvent, SubscriptionEnd<undefined>>;

/** A frame app that reports telemetry to each subscriber, keeping its sink. */
function createReportingFrame(sinks: TelemetrySink[]): (serving: ProtocolTransport) => void {
  return serving => {
    serving.handleSubscription(frame.telemetry, (_start, _context, sink) => {
      sinks.push(sink);
      return () => undefined;
    });
  };
}

describe('createFrameTelemetry', () => {
  let sinks: TelemetrySink[];
  let timers: ManualTimers;

  function settle(): Promise<void> {
    return timers.advance(0);
  }

  /** The frame up now reporting `event`. */
  function report(event: TelemetryEvent): void {
    sinks.at(-1)?.send(event);
  }

  beforeEach(() => {
    timers = createManualTimers();
    sinks = [];
  });

  it("As the network panel, I drop a byte total that goes back and start a rebuilt frame's count over", async () => {
    // Given
    const fake = createFakeFrame({ serve: createReportingFrame(sinks), timers });
    const telemetry = createFrameTelemetry({ frame: fake.frame, timers });
    const totals: number[] = [];
    telemetry.subscribeNetBytes(event => totals.push(event.received));
    await settle();

    // When
    report({ tag: 'netBytes', value: 100 });
    report({ tag: 'netBytes', value: 50 });
    await settle();
    fake.lose(new Error('boom'));
    fake.setStatus('booting');
    fake.setStatus('ready');
    await settle();
    report({ tag: 'netBytes', value: 10 });
    await settle();

    // Then
    expect(sinks).toHaveLength(2);
    expect(totals).toEqual([100, 10]);
  });

  it('As the network panel, I see a telemetry feed the frame ends while it stays up reopened after a wait, reported, and heard again', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const fake = createFakeFrame({ serve: createReportingFrame(sinks), timers });
    const telemetry = createFrameTelemetry({ frame: fake.frame, timers });
    const totals: number[] = [];
    telemetry.subscribeNetBytes(event => totals.push(event.received));
    await settle();
    report({ tag: 'netBytes', value: 100 });

    // When the frame ends the feed, and the reopened one reports a later total
    sinks.at(-1)?.interrupt(ok());
    await timers.advance(999);
    const openedBeforeWait = sinks.length;
    await timers.advance(1);
    report({ tag: 'netBytes', value: 150 });
    await settle();

    // Then
    expect([openedBeforeWait, sinks.length]).toEqual([1, 2]);
    expect(totals).toEqual([100, 150]);
    expect(metrics.counted('protocol.feed_end')).toEqual([
      { outcome: 'error', feed: 'telemetry', reason: 'ProtocolFeedEndedError' },
    ]);
    expect(captured).toMatchObject([{ step: 'feed_end', tags: { feed: 'telemetry' } }]);
  });

  it('As the network panel, I see an event past the telemetry limits end the feed, which is reported as malformed and reopened', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fake = createFakeFrame({ serve: createReportingFrame(sinks), timers });
    const telemetry = createFrameTelemetry({ frame: fake.frame, timers });
    const syncs: ChainSyncEvent[] = [];
    telemetry.subscribeChainSync(event => syncs.push(event));
    await settle();

    // When the frame reports more sync peers than a span may carry
    report({ tag: 'chainSync', value: { chain: 'relay', kind: 'peers', peers: 10_001 } });
    await timers.advance(1_000);

    // Then
    expect(syncs).toEqual([]);
    expect(sinks).toHaveLength(2);
    expect(metrics.counted('protocol.feed_end')).toEqual([
      { outcome: 'error', feed: 'telemetry', reason: 'MalformedFrame' },
    ]);
  });

  it('As the network panel, I hear chain sync and chain detail as the frame reports them', async () => {
    // Given
    const fake = createFakeFrame({ serve: createReportingFrame(sinks), timers });
    const telemetry = createFrameTelemetry({ frame: fake.frame, timers });
    const syncs: ChainSyncEvent[] = [];
    const details: ChainDetail[] = [];
    telemetry.subscribeChainSync(event => syncs.push(event));
    telemetry.subscribeChainDetail(event => details.push(event));
    await settle();

    // When
    report({ tag: 'chainSync', value: { chain: 'relay', kind: 'peers', peers: 3 } });
    report({ tag: 'chainDetail', value: { chain: 'assethub', dbCache: 'hit' } });
    await settle();

    // Then
    expect(syncs).toEqual([{ chain: 'relay', kind: 'peers', peers: 3 }]);
    expect(details).toEqual([{ chain: 'assethub', dbCache: 'hit' }]);
  });

  it("As a dotli integrator, I read none of the last frame's smoldot DB outcomes once a new one boots", async () => {
    // Given
    const fake = createFakeFrame({ serve: createReportingFrame(sinks), timers });
    const telemetry = createFrameTelemetry({ frame: fake.frame, timers });
    await settle();

    // When
    report({ tag: 'smoldotDb', value: { chain: 'relay', outcome: 'hit' } });
    await settle();
    const beforeRebuild = [telemetry.getSmoldotDbOutcome('relay'), telemetry.getSmoldotDbOutcome('assethub')];
    fake.lose(new Error('boom'));
    fake.setStatus('booting');

    // Then
    expect(beforeRebuild).toEqual(['hit', 'unknown']);
    expect(telemetry.getSmoldotDbOutcome('relay')).toBe('unknown');
  });
});
