// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindLogSink, type LogEntry } from '@dotli/shared';

import { bindCaptureSink, type CaptureContext, type CaptureSink } from './captureException.js';
import { reportDefect } from './reportDefect.js';
import { bindRecordingSentry } from './testing/index.js';

type ErrorLine = { [Key in 'attrs' | 'args']: LogEntry[Key] };

/** Records what a defect leaves behind: its captures, its counts and its error lines. */
function recordReports() {
  const captures: Parameters<CaptureSink['exception']>[] = [];
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const lines: ErrorLine[] = [];

  function recordCapture(error: unknown, context: CaptureContext): void {
    captures.push([error, context]);
  }

  onTestFinished(bindCaptureSink({ exception: recordCapture, expected: () => undefined }));
  onTestFinished(
    bindLogSink({
      emit({ level, attrs, args }) {
        if (level === 'error') {
          lines.push({ attrs, args });
        }
      },
    }),
  );
  return { captures, counted: metrics.counted, lines };
}

describe('reportDefect', () => {
  it('As an operator, I read a defect as one issue, one error line and one error count named after its class', () => {
    // Given a recorder and a defect thrown as a TypeError
    const reports = recordReports();
    const failure = new TypeError('unpin refused');

    // When the defect is reported
    reportDefect(failure, {
      flow: 'resolve',
      step: 'unpin',
      metric: 'resolve.unpin',
      message: '[test] unpin failed:',
    });

    // Then one issue, one error line with the error after the message, and one count named after the class
    expect(reports.captures).toEqual([[failure, { flow: 'resolve', step: 'unpin' }]]);
    expect(reports.lines).toEqual([{ attrs: {}, args: ['[test] unpin failed:', failure] }]);
    expect(reports.counted('resolve.unpin')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });

  it('As an operator, I read a thrown non-error and it is counted as an error with an unknown reason', () => {
    // Given a recorder and a thrown string
    const reports = recordReports();

    // When the string is reported as a defect
    reportDefect('unpin refused', {
      flow: 'resolve',
      step: 'unpin',
      metric: 'resolve.unpin',
      message: '[test] unpin failed:',
    });

    // Then the count names no class
    expect(reports.counted('resolve.unpin')).toEqual([{ outcome: 'error', reason: 'unknown' }]);
  });

  it('As a dotli developer, I report with my own reason, outcome, tags and attributes and each reaches its place', () => {
    // Given a recorder and a defect
    const reports = recordReports();
    const failure = new Error('no matching request');

    // When the defect is reported with its own reason, outcome, tags and attributes
    reportDefect(failure, {
      flow: 'wallet',
      step: 'phone_review',
      tags: { method: 'sign' },
      metric: 'signing.phone_review',
      message: '[test] review unmatched:',
      reason: 'mismatch',
      outcome: 'unmatchable',
      attributes: { method: 'sign' },
    });

    // Then the tags reach the issue, and the reason, outcome and attributes reach the count
    expect(reports.captures).toEqual([[failure, { flow: 'wallet', step: 'phone_review', tags: { method: 'sign' } }]]);
    expect(reports.counted('signing.phone_review')).toEqual([
      { outcome: 'unmatchable', reason: 'mismatch', method: 'sign' },
    ]);
  });

  it('As a dotli developer, I pass attributes named outcome and reason and the count is an error with the class name', () => {
    // Given a recorder and a TypeError
    const reports = recordReports();

    // When the defect is reported with attributes that name an outcome and a reason
    reportDefect(new TypeError('unpin refused'), {
      flow: 'resolve',
      step: 'unpin',
      metric: 'resolve.unpin',
      message: '[test] unpin failed:',
      attributes: { outcome: 'ok', reason: 'x' },
    });

    // Then the count keeps the default outcome and the class name
    expect(reports.counted('resolve.unpin')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });
});
