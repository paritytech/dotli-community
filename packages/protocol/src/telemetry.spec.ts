// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import type { SmoldotDbOutcome } from './messages.js';
import { createFrameTelemetry } from './telemetry.js';
import { createFakeFrame } from './frame.fake.js';

describe('createFrameTelemetry', () => {
  it("As the network panel, I drop a byte total that goes back and start a rebuilt frame's count over", () => {
    // Given
    const fake = createFakeFrame();
    const telemetry = createFrameTelemetry(fake.frame);
    const totals: number[] = [];
    telemetry.onProtocolNetBytes(event => totals.push(event.received));

    // When
    fake.send({ namespace: 'dotli:protocol', kind: 'net-bytes', received: 100 });
    fake.send({ namespace: 'dotli:protocol', kind: 'net-bytes', received: 50 });
    fake.lose(new Error('Fatal: boom'));
    fake.send({ namespace: 'dotli:protocol', kind: 'net-bytes', received: 10 });

    // Then
    expect(totals).toEqual([100, 10]);
  });

  it('As a dotli integrator, a smoldot DB outcome outside the known values is ignored, and a new frame forgets the last ones', () => {
    // Given
    const fake = createFakeFrame();
    const telemetry = createFrameTelemetry(fake.frame);

    // When
    fake.send({ namespace: 'dotli:protocol', kind: 'smoldot-db', chain: 'relay', outcome: 'hit' });
    fake.send({
      namespace: 'dotli:protocol',
      kind: 'smoldot-db',
      chain: 'assethub',
      outcome: 'bogus' as SmoldotDbOutcome,
    });
    const beforeRebuild = [telemetry.getSmoldotDbOutcome('relay'), telemetry.getSmoldotDbOutcome('assethub')];
    fake.setStatus('booting');

    // Then
    expect(beforeRebuild).toEqual(['hit', 'unknown']);
    expect(telemetry.getSmoldotDbOutcome('relay')).toBe('unknown');
  });

  it('As the network panel, a net bytes listener that throws is reported and the next one still hears the total', () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const fake = createFakeFrame();
    const telemetry = createFrameTelemetry(fake.frame);
    telemetry.onProtocolNetBytes(() => {
      throw new TypeError('panel broke');
    });
    const totals: number[] = [];
    telemetry.onProtocolNetBytes(event => totals.push(event.received));

    // When
    fake.send({ namespace: 'dotli:protocol', kind: 'net-bytes', received: 100 });

    // Then
    expect(totals).toEqual([100]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'protocol.net_bytes' } }]);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'protocol.net_bytes' },
    ]);
  });
});
