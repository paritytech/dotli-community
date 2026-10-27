// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { copyText } from './copyText.js';

/** The captures and copy counts this test leaves. */
function recordReports() {
  const exceptions: unknown[] = [];
  const expected: { error: unknown; context: CaptureContext }[] = [];
  onTestFinished(
    bindCaptureSink({
      exception: error => exceptions.push(error),
      expected: (error, context) => expected.push({ error, context }),
    }),
  );
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  return { exceptions, expected, listCopies: () => metrics.counted('debug_panel.copy') };
}

describe('debug panel copy', () => {
  it('As a dotli developer, I copy a value the browser takes and the copy reads Copied', async () => {
    // Given
    const copied: string[] = [];

    // When
    const outcome = await copyText(text => {
      copied.push(text);
      return Promise.resolve();
    }, 'app.dot.li');

    // Then
    expect(outcome).toBe('copied');
    expect(copied).toEqual(['app.dot.li']);
  });

  it('As a dotli developer whose browser refuses the clipboard, I copy a value and it reads Copy failed with the refusal recorded once as expected', async () => {
    // Given a browser that refuses the clipboard, and a fake Sentry that counts
    const reports = recordReports();
    const refusal = new DOMException('Write permission denied.', 'NotAllowedError');

    // When
    const outcome = await copyText(() => Promise.reject(refusal), 'app.dot.li');

    // Then the refusal is a breadcrumb and one count, not an issue
    expect(outcome).toBe('failed');
    expect(reports.exceptions).toEqual([]);
    expect(reports.expected).toEqual([{ error: refusal, context: { flow: 'ui', step: 'debug_panel_copy' } }]);
    expect(reports.listCopies()).toEqual([{ outcome: 'error', reason: 'NotAllowedError' }]);
  });
});
