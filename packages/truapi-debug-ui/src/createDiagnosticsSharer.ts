// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createAsyncTaskPool } from '@dotli/shared';
import type { DiagnosticsRow, DiagnosticsSource } from './host.js';
import { shareDiagnostics } from './shareDiagnostics.js';

type Params = {
  /** Builds the report and opens the issue. */
  source: Pick<DiagnosticsSource, 'report' | 'openIssue'>;
  /** Told when a share starts and ends, so the button can read busy. */
  onBusy: (busy: boolean) => void;
};

const SHARE_POOL = 'diagnostics_share';

/** The Share diagnostic button's command. Opening a tab is not idempotent, so overlapping clicks share once. */
export function createDiagnosticsSharer({ source, onBusy }: Params) {
  const shares = createAsyncTaskPool({ poolSize: 1 });
  // A share answers every click made in its round. The round ends with the share, so a later click shares again.
  let round = {};
  return {
    /**
     * Shares the report of `rows`, which the tab shows. A click in a running share's round belongs to that round,
     * whatever rows it passes, so it settles with the share and opens no second issue. A failed share is reported
     * here, not rejected.
     */
    share(rows: readonly DiagnosticsRow[]): Promise<void> {
      const asked = round;
      return shares.call(
        async () => {
          if (asked !== round) {
            return;
          }
          onBusy(true);
          try {
            await shareDiagnostics(source, rows);
          } finally {
            round = {};
            onBusy(false);
          }
        },
        { pool: SHARE_POOL },
      );
    },
  };
}
