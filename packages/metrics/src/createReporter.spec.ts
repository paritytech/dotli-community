// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { recordLog } from '@dotli/shared/testing';

import { bindCaptureSink, type CaptureContext } from './captureException.js';
import { createReporter } from './createReporter.js';
import { defineCount } from './defineCount.js';
import { bindRecordingSentry } from './testing/index.js';

/** Records what a reporter leaves behind: its issues, its breadcrumbs, its counts and its log lines. */
function recordReporterOutput() {
  const issues: [unknown, CaptureContext][] = [];
  const breadcrumbs: [unknown, Pick<CaptureContext, 'flow' | 'step'>][] = [];
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const lines = recordLog({ onFinished: onTestFinished });
  onTestFinished(
    bindCaptureSink({
      exception: (error, context) => {
        issues.push([error, context]);
      },
      expected: (error, context) => {
        breadcrumbs.push([error, context]);
      },
    }),
  );
  return { issues, breadcrumbs, counted: metrics.counted, lines };
}

describe('createReporter', () => {
  it('As a feature, I report a defect and its issue, error line and count all carry my flow and step', () => {
    // Given a recorder, a reporter for one flow and a metric that declares `error`
    const reports = recordReporterOutput();
    const report = createReporter({ flow: 'wallet' });
    const qrRenderMetric = defineCount<'error'>('test.qr_render');
    const failure = new TypeError('canvas lost');

    // When the feature reports a defect without an outcome
    report.defect(failure, { step: 'qr_render', metric: qrRenderMetric, message: '[test] QR render failed:' });

    // Then the issue, the error line and the error count carry the flow and the step
    expect(reports.issues).toEqual([[failure, { flow: 'wallet', step: 'qr_render' }]]);
    expect(reports.lines).toEqual([
      {
        level: 'error',
        message: '[test] QR render failed: canvas lost',
        attrs: { flow: 'wallet' },
        args: ['[test] QR render failed:', failure],
      },
    ]);
    expect(reports.counted('test.qr_render')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it('As a feature, I report an expected failure and its breadcrumb, warning and count carry my flow and step', () => {
    // Given a recorder, a reporter for one flow and a metric with its own outcomes
    const reports = recordReporterOutput();
    const report = createReporter({ flow: 'storage' });
    const cacheMetric = defineCount<'error' | 'timeout'>('test.ui_cache');
    const failure = new Error('timed out');

    // When the feature reports an expected failure with its own outcome and a warning
    report.expected(failure, {
      step: 'ui_cache',
      metric: cacheMetric,
      outcome: 'timeout',
      reason: 'timeout',
      message: '[test] cache read timed out:',
    });

    // Then the breadcrumb, the warning and the count carry the flow and the step
    expect(reports.breadcrumbs).toEqual([[failure, { flow: 'storage', step: 'ui_cache' }]]);
    expect(reports.lines).toEqual([
      {
        level: 'warn',
        message: '[test] cache read timed out: timed out',
        attrs: { flow: 'storage' },
        args: ['[test] cache read timed out:', failure],
      },
    ]);
    expect(reports.counted('test.ui_cache')).toEqual([{ outcome: 'timeout', reason: 'timeout' }]);
  });

  it('As a feature, I report a defect with my own reason, outcome, tags and attributes and each reaches its place', () => {
    // Given a recorder, a reporter and a metric with its own outcomes
    const reports = recordReporterOutput();
    const report = createReporter({ flow: 'wallet' });
    const reviewMetric = defineCount<'unmatchable'>('test.phone_review');
    const failure = new Error('no matching request');

    // When the defect is reported with its own reason, outcome, tags and attributes
    report.defect(failure, {
      step: 'phone_review',
      tags: { method: 'sign' },
      metric: reviewMetric,
      message: '[test] review unmatched:',
      reason: 'mismatch',
      outcome: 'unmatchable',
      attributes: { method: 'sign' },
    });

    // Then the tags reach the issue, and the reason, outcome and attributes reach the count
    expect(reports.issues).toEqual([[failure, { flow: 'wallet', step: 'phone_review', tags: { method: 'sign' } }]]);
    expect(reports.counted('test.phone_review')).toEqual([
      { outcome: 'unmatchable', reason: 'mismatch', method: 'sign' },
    ]);
  });

  it('As a feature, I report a thrown non-error and it is counted as an error with an unknown reason', () => {
    // Given a recorder and a reporter
    const reports = recordReporterOutput();
    const report = createReporter({ flow: 'resolve' });

    // When a thrown string is reported as a defect
    report.defect('unpin refused', {
      step: 'unpin',
      metric: defineCount<'error'>('test.unpin'),
      message: '[test] unpin failed:',
    });

    // Then the count names no class
    expect(reports.counted('test.unpin')).toEqual([{ outcome: 'error', reason: 'unknown' }]);
  });

  it("As a feature, I pass attributes named outcome and reason and the report's own win", () => {
    // Given a recorder and a reporter
    const reports = recordReporterOutput();
    const report = createReporter({ flow: 'ui' });

    // When a failure is reported with attributes that name an outcome and a reason
    report.expected(new TypeError('refused'), {
      step: 'icon',
      metric: defineCount<'error'>('test.icon'),
      attributes: { outcome: 'ok', reason: 'x' },
    });

    // Then the count keeps the default outcome and the class name
    expect(reports.counted('test.icon')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it('As a feature, I report an expected failure without a message and it is counted while nothing is logged', () => {
    // Given a recorder and a reporter
    const reports = recordReporterOutput();
    const report = createReporter({ flow: 'ui' });
    const timeout = new Error('timed out');

    // When
    report.expected(timeout, {
      step: 'diagnostics_block',
      metric: defineCount<'timeout'>('test.finalized_block'),
      outcome: 'timeout',
      reason: 'timeout',
    });

    // Then
    expect(reports.lines).toEqual([]);
    expect(reports.counted('test.finalized_block')).toEqual([{ outcome: 'timeout', reason: 'timeout' }]);
  });

  it('As a feature, I capture a failure and it becomes one issue under my flow with no line and no count', () => {
    // Given a recorder and a reporter for one flow
    const reports = recordReporterOutput();
    const report = createReporter({ flow: 'resolve' });
    const failure = new Error('manifest unreadable');

    // When the feature captures a failure with its step and tags
    report.capture(failure, { step: 'manifest_read', tags: { tld: 'dot' } });

    // Then one issue carries the flow, the step and the tags, and nothing is logged
    expect(reports.issues).toEqual([[failure, { flow: 'resolve', step: 'manifest_read', tags: { tld: 'dot' } }]]);
    expect(reports.lines).toEqual([]);
  });

  it('As an owner of listeners, I report a throwing listener and it is a defect under my flow counted with my name', () => {
    // Given a recorder and the listener report of one owner
    const reports = recordReporterOutput();
    const report = createReporter({ flow: 'protocol' });
    const onListenerError = report.listener('chain_pool.status');
    const broken = new TypeError('listener broke');

    // When a listener throws
    onListenerError(broken);

    // Then the issue, the error line and the delivery count carry the flow and the owner
    expect(reports.issues).toEqual([
      [broken, { flow: 'protocol', step: 'listener', tags: { owner: 'chain_pool.status' } }],
    ]);
    expect(reports.lines).toEqual([
      {
        level: 'error',
        message: '[dot.li] A chain_pool.status listener threw listener broke',
        attrs: { flow: 'protocol' },
        args: ['[dot.li] A chain_pool.status listener threw', broken],
      },
    ]);
    expect(reports.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'chain_pool.status' },
    ]);
  });

  it('As a feature, I cannot report a defect without an outcome under a metric that does not declare error', () => {
    // Given a recorder, a reporter and a metric whose outcomes leave out `error`
    const reports = recordReporterOutput();
    const report = createReporter({ flow: 'wallet' });
    const signMetric = defineCount<'refused'>('test.sign');

    // When the feature reports a defect under it without an outcome
    // @ts-expect-error The metric does not declare `error`, so the report must name its outcome
    report.defect(new TypeError('refused'), { step: 'sign', metric: signMetric, message: '[test] sign failed:' });

    // Then only the type check rejects it, and the default outcome still lands at runtime
    expect(reports.counted('test.sign')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });
});
