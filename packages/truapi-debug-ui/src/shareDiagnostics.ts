// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sharing the Diagnostics tab as a pre-filled GitHub issue, apart from the view so it is tested without a DOM.

import { captureException, m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { DiagnosticsRow, DiagnosticsSource } from './host.js';

/** A closed set, so the metric's `reason` tag stays bounded. */
type ShareFailureReason = 'report' | 'open';

/** Opens an issue with the report of `rows`, the rows the tab shows. A failure is reported here, never thrown. */
export async function shareDiagnostics(
  source: Pick<DiagnosticsSource, 'report' | 'openIssue'>,
  rows: readonly DiagnosticsRow[],
): Promise<void> {
  let report: string;
  try {
    report = await source.report(rows);
  } catch (error) {
    reportShareFailure(error, 'report');
    return;
  }
  try {
    source.openIssue(buildIssueUrl(report));
  } catch (error) {
    reportShareFailure(error, 'open');
    return;
  }
  m.count(S.DIAGNOSTICS_SHARE, { outcome: 'ok' });
}

function buildIssueUrl(report: string): string {
  const body = [
    '<!-- Describe the issue above this line; the diagnostics below are auto-filled. -->',
    '',
    '## Diagnostics',
    '',
    '```',
    report,
    '```',
  ].join('\n');
  const url = new URL('https://github.com/paritytech/dotli/issues/new');
  url.searchParams.set('body', body);
  return url.toString();
}

function reportShareFailure(error: unknown, reason: ShareFailureReason): void {
  log.error(`[dot.li debug] diagnostics ${reason} failed:`, error);
  captureException(error, { flow: 'ui', step: 'diagnostics_share', tags: { reason } });
  m.count(S.DIAGNOSTICS_SHARE, { outcome: 'error', reason });
}
