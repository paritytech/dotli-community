// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onTestFinished } from 'vitest';
import { bindCaptureSink, type CaptureContext } from '@dotli/metrics';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink } from '@dotli/shared';

/** What the running test reports, as recorded so far. */
export type ShareReports = {
  /** Each captured exception with its context, in capture order. */
  captured: { error: unknown; context: CaptureContext }[];
  /** The message of each error log line, in log order. */
  errors: string[];
  /** The attributes of each `diagnostics.share` count, in count order. Never throws. */
  listShares: () => ReturnType<RecordingSentry['counted']>;
};

/** The captures, error lines and share counts the running test leaves, unbound when it finishes. Never throws. */
export function recordShareReports(): ShareReports {
  const captured: ShareReports['captured'] = [];
  const errors: ShareReports['errors'] = [];
  onTestFinished(
    bindCaptureSink({
      exception: (error, context) => captured.push({ error, context }),
      expected: () => undefined,
    }),
  );
  onTestFinished(
    bindLogSink({
      emit: ({ level, message }) => {
        if (level === 'error') {
          errors.push(message);
        }
      },
    }),
  );
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  return { captured, errors, listShares: () => metrics.counted('diagnostics.share') };
}
