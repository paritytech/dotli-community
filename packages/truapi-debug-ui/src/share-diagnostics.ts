// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Sharing the Diagnostics tab as a pre-filled GitHub issue, apart from the view so it is tested without a DOM.

import { captureException, m, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, log } from '@dotli/shared';
import type { DiagnosticsRow, DiagnosticsSource } from './host.js';

function issueUrl(report: string): string {
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

/** A closed set, so the metric's `reason` tag stays bounded. */
type ShareFailureReason = 'report' | 'open';

function reportShareFailure(error: unknown, reason: ShareFailureReason): void {
  log.error(`[dot.li debug] diagnostics ${reason} failed:`, error);
  captureException(error, { flow: 'ui', step: 'diagnostics_share', tags: { reason } });
  m.count(S.DIAGNOSTICS_SHARE, { outcome: 'error', reason });
}

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
    source.openIssue(issueUrl(report));
  } catch (error) {
    reportShareFailure(error, 'open');
    return;
  }
  m.count(S.DIAGNOSTICS_SHARE, { outcome: 'ok' });
}

export interface DiagnosticsSharer {
  /** Shares the report. A click while a share runs belongs to it, so it settles with it and opens no second issue. */
  share(): Promise<void>;
}

export interface DiagnosticsSharerDeps {
  source: Pick<DiagnosticsSource, 'report' | 'openIssue'>;
  rows: readonly DiagnosticsRow[];
  /** Told when a share starts and ends, so the button can read busy. */
  onBusy: (busy: boolean) => void;
}

const SHARE_POOL = 'diagnostics_share';

/** The Share diagnostic button's command. Opening a tab is not idempotent, so overlapping clicks share once. */
export function createDiagnosticsSharer(deps: DiagnosticsSharerDeps): DiagnosticsSharer {
  const shares = createAsyncTaskPool({ poolSize: 1 });
  // A share answers every click made in its round. The round ends with the share, so a later click shares again.
  let round = {};
  return {
    share() {
      const asked = round;
      return shares.call(
        async () => {
          if (asked !== round) {
            return;
          }
          deps.onBusy(true);
          try {
            await shareDiagnostics(deps.source, deps.rows);
          } finally {
            round = {};
            deps.onBusy(false);
          }
        },
        { pool: SHARE_POOL },
      );
    },
  };
}
