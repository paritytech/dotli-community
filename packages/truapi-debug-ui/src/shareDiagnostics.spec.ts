// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { DiagnosticsRow } from './host.js';
import { shareDiagnostics } from './shareDiagnostics.js';
import { fakeDiagnosticsSource } from './testing/fakeDiagnosticsSource.js';
import { recordShareReports } from './testing/recordShareReports.js';

const ROWS: DiagnosticsRow[] = [
  ['Site', 'app.dot.li'],
  ['Build', '1.4.0 (abc1234)'],
];

describe('sharing diagnostics', () => {
  it('As a dotli developer, I share diagnostics and a GitHub issue opens prefilled with the report of the rows I see', async () => {
    // Given
    const reports = recordShareReports();
    const source = fakeDiagnosticsSource();

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
    expect(reports.listShares()).toEqual([{ outcome: 'ok' }]);
  });

  it('As a dotli developer whose report could not be built, I share diagnostics and no issue opens while the failure is reported', async () => {
    // Given
    const reports = recordShareReports();
    const failure = new Error('permissions read failed');
    const source = fakeDiagnosticsSource({ report: () => Promise.reject(failure) });

    // When
    await shareDiagnostics(source, ROWS);

    // Then one log, one capture and one count
    expect(reports.captured).toEqual([
      { error: failure, context: { flow: 'ui', step: 'diagnostics_share', tags: { reason: 'report' } } },
    ]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.listShares()).toEqual([{ outcome: 'error', reason: 'report' }]);
    expect(source.openIssue).not.toHaveBeenCalled();
  });

  it('As a dotli developer whose browser would not open the issue, I share diagnostics and the failure is reported once', async () => {
    // Given a browser that refuses to open the issue page
    const reports = recordShareReports();
    const failure = new Error('popup blocked');
    const source = fakeDiagnosticsSource();
    source.openIssue.mockImplementationOnce(() => {
      throw failure;
    });

    // When
    await shareDiagnostics(source, ROWS);

    // Then reported as an open failure, and never counted as shared
    expect(reports.captured).toEqual([
      { error: failure, context: { flow: 'ui', step: 'diagnostics_share', tags: { reason: 'open' } } },
    ]);
    expect(reports.errors).toHaveLength(1);
    expect(reports.listShares()).toEqual([{ outcome: 'error', reason: 'open' }]);
  });
});
