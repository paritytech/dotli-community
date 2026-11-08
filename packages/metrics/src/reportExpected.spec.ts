// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindLogSink } from '@dotli/shared';

import { bindCaptureSink, type CaptureContext } from './captureException.js';
import { reportExpected } from './reportExpected.js';
import { bindRecordingSentry } from './testing/index.js';

/** Records what an expected failure leaves behind: its breadcrumb, its counts and its warnings. */
function recordReports() {
  const breadcrumbs: [unknown, Pick<CaptureContext, 'flow' | 'step'>][] = [];
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const warnings: unknown[][] = [];
  onTestFinished(
    bindCaptureSink({
      exception: () => undefined,
      expected: (error, context) => {
        breadcrumbs.push([error, context]);
      },
    }),
  );
  onTestFinished(
    bindLogSink({
      emit: ({ level, args }) => {
        if (level === 'warn') {
          warnings.push(args ?? []);
        }
      },
    }),
  );
  return { breadcrumbs, counted: metrics.counted, warnings };
}

describe('reportExpected', () => {
  it('As an operator, I read an environment failure as a warning, a breadcrumb and one error count naming its reason', () => {
    // Given
    const reports = recordReports();
    const failure = new Error('storage refused');

    // When
    reportExpected(failure, {
      flow: 'storage',
      step: 'ui_cache',
      metric: 'shared_session.ui_cache',
      reason: 'read',
      message: '[test] cache read failed:',
    });

    // Then
    expect(reports.warnings).toEqual([['[test] cache read failed:', failure]]);
    expect(reports.breadcrumbs).toEqual([[failure, { flow: 'storage', step: 'ui_cache' }]]);
    expect(reports.counted('shared_session.ui_cache')).toEqual([{ outcome: 'error', reason: 'read' }]);
  });

  it('As a dotli developer, I report a slow network as a timeout without a message and it is counted with that outcome and logs nothing', () => {
    // Given
    const reports = recordReports();
    const timeout = new Error('timed out');

    // When
    reportExpected(timeout, {
      flow: 'ui',
      step: 'diagnostics_block',
      metric: 'diagnostics.finalized_block',
      outcome: 'timeout',
      reason: 'timeout',
    });

    // Then
    expect(reports.warnings).toEqual([]);
    expect(reports.breadcrumbs).toEqual([[timeout, { flow: 'ui', step: 'diagnostics_block' }]]);
    expect(reports.counted('diagnostics.finalized_block')).toEqual([{ outcome: 'timeout', reason: 'timeout' }]);
  });

  it('As a dotli developer, I report an expected failure with attributes and the count keeps them beside its outcome and reason', () => {
    // Given a recorder and a failure the browser caused
    const reports = recordReports();

    // When the failure is reported with count attributes and its own reason
    reportExpected(new Error('quota'), {
      flow: 'storage',
      step: 'block_cache',
      metric: 'cache.storage',
      reason: 'QuotaExceededError',
      attributes: { surface: 'block_cache', step: 'read' },
    });

    // Then the count carries the attributes beside the outcome and the reason
    expect(reports.counted('cache.storage')).toEqual([
      { outcome: 'error', reason: 'QuotaExceededError', surface: 'block_cache', step: 'read' },
    ]);
  });

  it('As a dotli developer, I report a thrown non-error as expected and it is counted with an unknown reason', () => {
    // Given a recorder
    const reports = recordReports();

    // When a string is reported as the failure
    reportExpected('refused', { flow: 'ui', step: 'icon', metric: 'product.icon' });

    // Then the count has the default outcome and the unknown reason
    expect(reports.counted('product.icon')).toEqual([{ outcome: 'error', reason: 'unknown' }]);
  });

  it('As a dotli developer, I report through my own logger and the warning goes through it alone', () => {
    // Given a recorder and a logger that records its warnings
    const reports = recordReports();
    const warned: unknown[][] = [];
    const logger = {
      warn: (...args: unknown[]) => {
        warned.push(args);
      },
    };
    const failure = new Error('storage refused');

    // When the failure is reported through that logger
    reportExpected(failure, {
      flow: 'storage',
      step: 'ui_cache',
      metric: 'shared_session.ui_cache',
      message: '[test] cache read failed:',
      logger,
    });

    // Then the warning went through the given logger and not the root log
    expect(warned).toEqual([['[test] cache read failed:', failure]]);
    expect(reports.warnings).toEqual([]);
  });

  it("As a dotli developer, I pass attributes named outcome and reason and the report's own win", () => {
    // Given a recorder
    const reports = recordReports();

    // When the failure is reported with attributes that name an outcome and a reason
    reportExpected(new TypeError('refused'), {
      flow: 'ui',
      step: 'icon',
      metric: 'product.icon',
      attributes: { outcome: 'ok', reason: 'x' },
    });

    // Then the count keeps the default outcome and the class name
    expect(reports.counted('product.icon')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });
});
