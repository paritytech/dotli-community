// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink } from '@dotli/shared';
import type { DiagnosticsRow } from './host.js';
import { createDiagnosticsSharer, shareDiagnostics } from './share-diagnostics.js';

const ROWS: DiagnosticsRow[] = [
  ['Site', 'app.dot.li'],
  ['Build', '1.4.0 (abc1234)'],
];

/** The captures, error lines and share counts this test leaves. */
function recordReports() {
  const captured: { error: unknown; ctx: CaptureContext }[] = [];
  const errors: string[] = [];
  onTestFinished(
    bindCaptureSink({
      exception: (error, ctx) => captured.push({ error, ctx }),
      expected: () => undefined,
    }),
  );
  onTestFinished(
    bindLogSink({
      emit: (level, message) => {
        if (level === 'error') {
          errors.push(message);
        }
      },
    }),
  );
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  return { captured, errors, shares: () => metrics.counted('diagnostics.share') };
}

/** The page's report and issue opener as a test sets them. */
function fakeSource(
  report: () => Promise<string> = () => Promise.resolve('Site: app.dot.li\nPackages:\n  smoldot: 0.3.1'),
) {
  return { report: vi.fn(report), openIssue: vi.fn<(url: string) => void>() };
}

describe('sharing diagnostics', () => {
  it('As a dotli developer, Share diagnostic opens a GitHub issue prefilled with the report of the rows I see', async () => {
    // Given
    const reports = recordReports();
    const source = fakeSource();

    // When
    await shareDiagnostics(source, ROWS);

    // Then
    expect(source.report).toHaveBeenCalledWith(ROWS);
    const url = new URL(source.openIssue.mock.calls[0]?.[0] ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/paritytech/dotli/issues/new');
    expect(url.searchParams.get('body')).toBe(
      [
        '<!-- Describe the issue above this line; the diagnostics below are auto-filled. -->',
        '',
        '## Diagnostics',
        '',
        '```',
        'Site: app.dot.li',
        'Packages:',
        '  smoldot: 0.3.1',
        '```',
      ].join('\n'),
    );
    expect(reports.captured).toEqual([]);
    expect(reports.shares()).toEqual([{ outcome: 'ok' }]);
  });

  it('As a dotli developer whose report could not be built, no issue opens and the failure is reported', async () => {
    // Given
    const reports = recordReports();
    const failure = new Error('permissions read failed');
    const source = fakeSource(() => Promise.reject(failure));

    // When
    await shareDiagnostics(source, ROWS);

    // Then one log, one capture and one count
    expect(reports.captured).toEqual([
      { error: failure, ctx: { flow: 'ui', step: 'diagnostics_share', tags: { reason: 'report' } } },
    ]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.shares()).toEqual([{ outcome: 'error', reason: 'report' }]);
    expect(source.openIssue).not.toHaveBeenCalled();
  });

  it('As a dotli developer whose browser would not open the issue, the failure is reported once', async () => {
    // Given a browser that refuses to open the issue page
    const reports = recordReports();
    const failure = new Error('popup blocked');
    const source = fakeSource();
    source.openIssue.mockImplementationOnce(() => {
      throw failure;
    });

    // When
    await shareDiagnostics(source, ROWS);

    // Then reported as an open failure, and never counted as shared
    expect(reports.captured).toEqual([
      { error: failure, ctx: { flow: 'ui', step: 'diagnostics_share', tags: { reason: 'open' } } },
    ]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.shares()).toEqual([{ outcome: 'error', reason: 'open' }]);
  });
});

describe('the Share diagnostic button', () => {
  it('As a dotli developer clicking Share diagnostic again while the report builds, one issue opens and the button reads busy until then', async () => {
    // Given
    recordReports();
    const built = Promise.withResolvers<string>();
    const source = fakeSource(() => built.promise);
    const busy: boolean[] = [];
    const sharer = createDiagnosticsSharer({ source, rows: ROWS, onBusy: value => busy.push(value) });

    // When
    const first = sharer.share();
    const second = sharer.share();

    // Then
    expect(busy).toEqual([true]);

    // When
    built.resolve('Site: app.dot.li');
    await Promise.all([first, second]);

    // Then
    expect(source.report).toHaveBeenCalledTimes(1);
    expect(source.openIssue).toHaveBeenCalledTimes(1);
    expect(busy).toEqual([true, false]);
  });

  it('As a dotli developer, a click after a share has ended shares again, even when that share failed', async () => {
    // Given
    recordReports();
    const source = fakeSource();
    source.report.mockRejectedValueOnce(new Error('permissions read failed'));
    const sharer = createDiagnosticsSharer({ source, rows: ROWS, onBusy: () => undefined });
    await sharer.share();

    // When
    await sharer.share();

    // Then
    expect(source.report).toHaveBeenCalledTimes(2);
    expect(source.openIssue).toHaveBeenCalledTimes(1);
  });
});
