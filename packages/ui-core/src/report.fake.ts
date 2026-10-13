// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExpectedContext, FailureContext, Reporter } from './report.js';

/** A reporter that keeps what it was given, for a spec or a story to read back. */
export interface RecordingReporter extends Reporter {
  readonly failures: { error: unknown; context: FailureContext }[];
  readonly misses: { error: unknown; context: ExpectedContext }[];
}

export function createRecordingReporter(): RecordingReporter {
  const failures: RecordingReporter['failures'] = [];
  const misses: RecordingReporter['misses'] = [];
  return {
    failures,
    misses,
    failure: (error, context) => {
      failures.push({ error, context });
    },
    expected: (error, context) => {
      misses.push({ error, context });
    },
  };
}
