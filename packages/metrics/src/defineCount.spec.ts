// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';

import { defineCount } from './defineCount.js';
import { bindRecordingSentry } from './testing/index.js';

describe('defineCount', () => {
  it('As a feature, I cannot count an outcome my metric does not declare', () => {
    // Given a recorder and a metric that declares one outcome
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const signMetric = defineCount<'signed'>('test.sign');

    // When the feature counts an undeclared outcome, and then no outcome
    // @ts-expect-error The metric does not declare this outcome
    signMetric.count({ outcome: 'refused' });
    // @ts-expect-error A metric that declares outcomes needs one on every count
    signMetric.count({ reason: 'user' });

    // Then only the type check rejects them, and the counts still land at runtime
    expect(metrics.counted('test.sign')).toEqual([{ outcome: 'refused' }, { reason: 'user' }]);
  });
});
