// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, onTestFinished } from 'vitest';
import { m, getResolutionId, setResolutionId } from './metrics.js';
import { bindRecordingSentry } from './testing/index.js';

describe('resolution id', () => {
  it('As the protocol client, I read back the id the host minted, and every later metric carries it', () => {
    // Given a realm that boots before the host mints an id, which reports none rather than a fabricated one
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    expect(getResolutionId()).toBeNull();

    // When the host mints it and a metric is counted
    setResolutionId('f1e2d3c4-b5a6-4778-8899-aabbccddeeff');
    m.count('test.after_id');

    // Then the host can thread it onto the iframe URLs it builds, and the metric and the Sentry scope carry it
    expect(getResolutionId()).toBe('f1e2d3c4-b5a6-4778-8899-aabbccddeeff');
    expect(metrics.counted('test.after_id')).toEqual([{ resolution_id: 'f1e2d3c4-b5a6-4778-8899-aabbccddeeff' }]);
    expect(metrics.tags).toContainEqual({
      key: 'dotli.resolution_id',
      value: 'f1e2d3c4-b5a6-4778-8899-aabbccddeeff',
    });
  });
});

describe('timer', () => {
  it('As a dotli integrator, I time a step on the clock I pass, and the span is measured and distributed once', () => {
    // Given a clock the test moves by hand
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    let now = 100;
    const stop = m.timer('test.step', () => now);

    // When
    now = 350;
    const ms = stop();

    // Then
    expect(ms).toBe(250);
    expect(metrics.distributions.map(metric => [metric.name, metric.value])).toEqual([['dotli.test.step', 250]]);
    expect(metrics.measurements).toEqual([{ name: 'dotli.test.step', value: 250, unit: 'millisecond' }]);
  });
});
