// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';

import { countMetric, defineCount, type CountSink } from './defineCount.js';
import { bindRecordingSentry } from './testing/index.js';

describe('defineCount', () => {
  it("As a feature, I count an outcome of my metric and it is recorded under the metric's name", () => {
    // Given a recorder and a metric that declares two outcomes
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const signMetric = defineCount<'signed' | 'refused'>('test.sign');

    // When the feature counts one of its outcomes
    signMetric.count({ outcome: 'refused', reason: 'user' });

    // Then the count is recorded under the prefixed name with its attributes
    expect(metrics.counted('test.sign')).toEqual([{ outcome: 'refused', reason: 'user' }]);
  });

  it('As a feature, I count a metric declared without outcomes and it is recorded with its attributes', () => {
    // Given a recorder and a metric that declares no outcomes
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const openMetric = defineCount('test.open');

    // When the feature counts it with an attribute
    openMetric.count({ source: 'link' });

    // Then the count is recorded with that attribute alone
    expect(metrics.counted('test.open')).toEqual([{ source: 'link' }]);
  });

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

  it('As a module that takes its counting as a param, I count through the default sink and the metric records it', () => {
    // Given a recorder, a metric and the default sink taken as a param
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const signMetric = defineCount<'signed' | 'refused'>('test.sign');
    const sink: CountSink = countMetric;

    // When the module counts through the sink
    sink(signMetric, { outcome: 'signed' });

    // Then the metric records the count
    expect(metrics.counted('test.sign')).toEqual([{ outcome: 'signed' }]);
  });
});
