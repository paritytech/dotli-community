// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { bindCaptureSink, captureException, recordExpected } from '../captureException.js';
import { recordReports } from './index.js';

describe('recordReports', () => {
  it('As a dotli developer, I read back each exception and expected failure with its step, error and tags', () => {
    // Given a recorder and a defect and an expected failure to report
    const finished: (() => void)[] = [];
    const reports = recordReports({ onFinished: restore => finished.push(restore) });
    const defect = new Error('defect');
    const expectedFailure = new Error('offline');

    // When both are reported and the recorder finishes
    captureException(defect, { flow: 'test_flow', step: 'render', tags: { kind: 'qr' } });
    captureException(defect, { flow: 'test_flow', step: 'paint' });
    recordExpected(expectedFailure, { flow: 'test_flow', step: 'fetch' });
    for (const restore of finished) {
      restore();
    }

    // Then the recorder holds each report with its step, error and tags
    expect(reports.exceptions).toEqual([
      { step: 'render', error: defect, tags: { kind: 'qr' } },
      { step: 'paint', error: defect, tags: undefined },
    ]);
    expect(reports.expected).toEqual([{ step: 'fetch', error: expectedFailure, tags: undefined }]);
  });

  it('As a dotli developer, I finish my test and the sink bound before is back', () => {
    // Given a sink bound before and a recorder bound after it
    const before: unknown[] = [];
    const restoreBefore = bindCaptureSink({ exception: error => before.push(error), expected: () => undefined });
    const finished: (() => void)[] = [];
    const reports = recordReports({ onFinished: restore => finished.push(restore) });
    const error = new Error('after');

    // When the recorder finishes and a later exception is reported
    for (const restore of finished) {
      restore();
    }
    captureException(error, { flow: 'test_flow', step: 'late' });
    restoreBefore();

    // Then the recorder stays empty and the sink bound before gets the exception
    expect(reports.exceptions).toEqual([]);
    expect(before).toEqual([error]);
  });
});
