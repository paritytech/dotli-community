// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sharing the Diagnostics tab as a pre-filled GitHub issue, apart from the view so it is tested without a DOM.

import { createReporter, defineCount } from '@dotli/metrics';
import type { DiagnosticsSnapshot, DiagnosticsSource } from './host.js';

const uiReport = createReporter({ flow: 'ui' });

/**
 * One Share diagnostic click in the debug panel. Tagged `outcome` and, on error, `reason`, as a failed one opens no
 * issue.
 */
const diagnosticsShareMetric = defineCount<'error' | 'ok'>('diagnostics.share');

/** Opens an issue with the report of `snapshot`, the page the tab shows. A failure is reported here, never thrown. */
export async function shareDiagnostics(
  source: Pick<DiagnosticsSource, 'report' | 'openIssue'>,
  snapshot: DiagnosticsSnapshot,
): Promise<void> {
  let report: string;
  try {
    report = await source.report(snapshot);
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
  diagnosticsShareMetric.count({ outcome: 'ok' });
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

/** `reason` is a closed set, so the metric's tag stays bounded. */
function reportShareFailure(error: unknown, reason: 'report' | 'open'): void {
  uiReport.defect(error, {
    step: 'diagnostics_share',
    tags: { reason },
    metric: diagnosticsShareMetric,
    reason,
    message: `[dot.li debug] diagnostics ${reason} failed:`,
  });
}
