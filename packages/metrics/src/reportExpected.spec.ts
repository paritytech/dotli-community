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
});
