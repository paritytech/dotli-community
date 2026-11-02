// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, onTestFinished } from 'vitest';
import { m } from './metrics.js';
import { bindRecordingSentry } from './testing/index.js';

describe('timer', () => {
  it('As a dotli integrator, I time a step on the clock I pass, and the span is measured and distributed once', () => {
    // Given a clock the test moves by hand
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    let now = 100;
    const stop = m.timer('test.step', { now: () => now });

    // When
    now = 350;
    const elapsed = stop();

    // Then
    expect(elapsed).toBe(250);
    expect(metrics.distributions.map(metric => [metric.name, metric.value])).toEqual([['dotli.test.step', 250]]);
    expect(metrics.measurements).toEqual([{ name: 'dotli.test.step', value: 250, unit: 'millisecond' }]);
  });
});
