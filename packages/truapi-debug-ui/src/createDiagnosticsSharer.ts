// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, type ReadableAtom } from 'nanostores';
import { createAsyncTaskPool } from '@dotli/shared';
import type { DiagnosticsSnapshot, DiagnosticsSource } from './host.js';
import { shareDiagnostics } from './shareDiagnostics.js';

type Params = {
  /** Builds the report and opens the issue. */
  source: Pick<DiagnosticsSource, 'report' | 'openIssue'>;
};

/** The Share diagnostic button's command, as its factory builds it. */
export type DiagnosticsSharer = ReturnType<typeof createDiagnosticsSharer>;

/** The Share diagnostic button's command. Opening a tab is not idempotent, so overlapping clicks share once. */
export function createDiagnosticsSharer({ source }: Params) {
  const shares = createAsyncTaskPool({ poolSize: 1 });
  const busy = atom(false);
  const busyStore: ReadableAtom<boolean> = busy;
  return {
    /** Whether a share runs, so the button reads busy. */
    busy: busyStore,
    /**
     * Shares the report of `snapshot`. A click while a share runs, whatever snapshot it passes, settles with that share
     * and opens no second issue. A failed share is reported here, not rejected.
     */
    share(snapshot: DiagnosticsSnapshot): Promise<void> {
      // The pool starts an idle share at once, so a share that runs is already busy here.
      const joining = busy.get();
      return shares.call(
        async () => {
          if (joining) {
            return;
          }
          busy.set(true);
          try {
            await shareDiagnostics(source, snapshot);
          } finally {
            busy.set(false);
          }
        },
        { pool: 'diagnostics_share' },
      );
    },
  };
}
