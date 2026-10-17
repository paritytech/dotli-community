// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import type { ChainDetail, ChainSyncEvent } from '@dotli/chains';
import type { TelemetryEvent } from './methods.js';
import { createFrameTelemetry } from './telemetry.js';
import { createFakeFrame } from './frame.fake.js';
import type { ServingTransport, SubscriptionSink } from './transport-serving.js';

/** A frame app that reports telemetry to each subscriber, keeping its sink. */
function reporting(sinks: SubscriptionSink<'telemetry'>[]): (serving: ServingTransport) => void {
  return serving => {
    serving.handleSubscription('telemetry', (_payload, _context, sink) => {
      sinks.push(sink);
      return () => undefined;
    });
  };
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('createFrameTelemetry', () => {
  let sinks: SubscriptionSink<'telemetry'>[];

  /** The frame up now reporting `event`. */
  const report = (event: TelemetryEvent): void => {
    sinks.at(-1)?.send(event);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sinks = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("As the network panel, I drop a byte total that goes back and start a rebuilt frame's count over", async () => {
    // Given
    const fake = createFakeFrame(reporting(sinks));
    const telemetry = createFrameTelemetry(fake.frame);
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

  it('As the network panel, I hear chain sync and chain detail as the frame reports them', async () => {
    // Given
    const fake = createFakeFrame(reporting(sinks));
    const telemetry = createFrameTelemetry(fake.frame);
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
    const fake = createFakeFrame(reporting(sinks));
    const telemetry = createFrameTelemetry(fake.frame);
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
    const fake = createFakeFrame(reporting(sinks));
    const telemetry = createFrameTelemetry(fake.frame);
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
