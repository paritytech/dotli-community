// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onTestFinished, vi } from 'vitest';
import { bindCaptureSink, type CaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';

type Params = {
  /** Called after each metric is recorded and each exception is captured, so a test can wait on a report. */
  onReport?: () => void;
};

/**
 * Binds a fake Sentry and a capture sink of spies for the running test, and puts back the ones bound before when it
 * finishes. Never throws.
 */
export function bindReports({ onReport = ignoreReport }: Params = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished, onRecord: onReport });
  const captures = {
    exception: vi.fn<CaptureSink['exception']>(() => {
      onReport();
    }),
    expected: vi.fn<CaptureSink['expected']>(),
  };
  onTestFinished(bindCaptureSink(captures));
  return {
    /** The capture sink's exception and expected-failure spies. */
    captures,
    /** The attributes of each count named `dotli.<name>`, in order. */
    counted: metrics.counted,
  };
}

function ignoreReport(): void {
  /* the test waits on no report */
}
