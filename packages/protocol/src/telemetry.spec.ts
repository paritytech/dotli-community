// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import type { ChainDetail, ChainSyncEvent } from '@dotli/chains';
import { manualTimers, type ManualTimers } from '@dotli/shared/testing';
import { ok, type Sink } from '@dotli/transport';
import { createFrameTelemetry } from './telemetry.js';
import { createFakeFrame } from './frame.fake.js';
import type { TelemetryEvent } from './codec-values.js';
import { protocolSchema, type ProtocolTransport, type SubscriptionEnd } from './schema.js';

const { frame } = protocolSchema.sections;

type TelemetrySink = Sink<TelemetryEvent, SubscriptionEnd<undefined>>;

/** A frame app that reports telemetry to each subscriber, keeping its sink. */
function reporting(sinks: TelemetrySink[]): (serving: ProtocolTransport) => void {
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

  const settle = (): Promise<void> => timers.advance(0);

  /** The frame up now reporting `event`. */
  const report = (event: TelemetryEvent): void => {
    sinks.at(-1)?.send(event);
  };

  beforeEach(() => {
    timers = manualTimers();
    sinks = [];
  });

  it("As the network panel, I drop a byte total that goes back and start a rebuilt frame's count over", async () => {
    // Given
    const fake = createFakeFrame(reporting(sinks), { timers });
    const telemetry = createFrameTelemetry(fake.frame, timers);
    const totals: number[] = [];
    telemetry.onProtocolNetBytes(event => totals.push(event.received));
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

  it('As the network panel, a telemetry feed the frame ends while it stays up is reopened after a wait, reported, and heard again', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    const fake = createFakeFrame(reporting(sinks), { timers });
    const telemetry = createFrameTelemetry(fake.frame, timers);
    const totals: number[] = [];
    telemetry.onProtocolNetBytes(event => totals.push(event.received));
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
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([
      { outcome: 'error', feed: 'telemetry', reason: 'ProtocolFeedEndedError' },
    ]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'feed_end', tags: { feed: 'telemetry' } }]);
  });

  it('As the network panel, an event past the telemetry limits ends the feed, which is reported as malformed and reopened', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fake = createFakeFrame(reporting(sinks), { timers });
    const telemetry = createFrameTelemetry(fake.frame, timers);
    const syncs: ChainSyncEvent[] = [];
    telemetry.onProtocolChainSync(event => syncs.push(event));
    await settle();

    // When the frame reports more sync peers than a span may carry
    report({ tag: 'chainSync', value: { chain: 'relay', kind: 'peers', peers: 10_001 } });
    await timers.advance(1_000);

    // Then
    expect(syncs).toEqual([]);
    expect(sinks).toHaveLength(2);
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([
      { outcome: 'error', feed: 'telemetry', reason: 'MalformedFrame' },
    ]);
  });

  it('As the network panel, a telemetry feed ended by the loss of its frame is not reopened there and not reported', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fake = createFakeFrame(reporting(sinks), { timers });
    createFrameTelemetry(fake.frame, timers);
    await settle();

    // When
    fake.lose(new Error('boom'));
    await timers.advance(30_000);

    // Then
    expect(sinks).toHaveLength(1);
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([]);
  });

  it('As the network panel, a frame lost while its telemetry is asked for is neither reported nor heard again', async () => {
    // Given a frame that boots and is dropped in the same turn, before its transport is handed over
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fake = createFakeFrame(reporting(sinks), { status: 'idle', timers });
    createFrameTelemetry(fake.frame, timers);

    // When
    fake.setStatus('booting');
    fake.lose(new Error('dropped'));
    await timers.advance(30_000);

    // Then
    expect(metrics.counted(S.PROTOCOL_FEED_END)).toEqual([]);
    expect(timers.pending()).toBe(0);
  });

  it('As the network panel, I hear chain sync and chain detail as the frame reports them', async () => {
    // Given
    const fake = createFakeFrame(reporting(sinks), { timers });
    const telemetry = createFrameTelemetry(fake.frame, timers);
    const syncs: ChainSyncEvent[] = [];
    const details: ChainDetail[] = [];
    telemetry.onProtocolChainSync(event => syncs.push(event));
    telemetry.onProtocolChainDetail(event => details.push(event));
    await settle();

    // When
    report({ tag: 'chainSync', value: { chain: 'relay', kind: 'peers', peers: 3 } });
    report({ tag: 'chainDetail', value: { chain: 'assethub', dbCache: 'hit' } });
    await settle();

    // Then
    expect(syncs).toEqual([{ chain: 'relay', kind: 'peers', peers: 3 }]);
    expect(details).toEqual([{ chain: 'assethub', dbCache: 'hit' }]);
  });

  it('As a dotli integrator, a new frame forgets the smoldot DB outcomes of the last one', async () => {
    // Given
    const fake = createFakeFrame(reporting(sinks), { timers });
    const telemetry = createFrameTelemetry(fake.frame, timers);
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

  it('As the network panel, a net bytes listener that throws is reported and the next one still hears the total', async () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fake = createFakeFrame(reporting(sinks), { timers });
    const telemetry = createFrameTelemetry(fake.frame, timers);
    telemetry.onProtocolNetBytes(() => {
      throw new TypeError('panel broke');
    });
    const totals: number[] = [];
    telemetry.onProtocolNetBytes(event => totals.push(event.received));
    await settle();

    // When
    report({ tag: 'netBytes', value: 100 });
    await settle();

    // Then
    expect(totals).toEqual([100]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'protocol.net_bytes' } }]);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'protocol.net_bytes' },
    ]);
  });
});
