// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { copyText } from './copy.js';

/** The captures and copy counts this test leaves. */
function recordReports() {
  const exceptions: unknown[] = [];
  const expected: { error: unknown; ctx: CaptureContext }[] = [];
  onTestFinished(
    bindCaptureSink({
      exception: error => exceptions.push(error),
      expected: (error, ctx) => expected.push({ error, ctx }),
    }),
  );
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  return { exceptions, expected, copies: () => metrics.counted('debug_panel.copy') };
}

describe('debug panel copy', () => {
  it('As a dotli developer, a copy the browser takes reads Copied', async () => {
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

  it('As a dotli developer whose browser refuses the clipboard, the copy reads Copy failed and the refusal is recorded once as expected', async () => {
    // Given a browser that refuses the clipboard, and a fake Sentry that counts
    const reports = recordReports();
    const refusal = new DOMException('Write permission denied.', 'NotAllowedError');

    // When
    const outcome = await copyText(() => Promise.reject(refusal), 'app.dot.li');

    // Then the refusal is a breadcrumb and one count, not an issue
    expect(outcome).toBe('failed');
    expect(reports.exceptions).toEqual([]);
    expect(reports.expected).toEqual([{ error: refusal, ctx: { flow: 'ui', step: 'debug_panel_copy' } }]);
    expect(reports.copies()).toEqual([{ outcome: 'error', reason: 'NotAllowedError' }]);
  });
});
