// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineCount, spans as S, type Reporter } from '@dotli/metrics';

/** A lazy chunk a caller could not load and went on without. Tagged `outcome` and `reason` (the caller's step). */
const lazyChunkLoadMetric = defineCount<'error'>(S.LAZY_CHUNK_LOAD);

type Params = {
  /** The caller's reporter, whose flow the miss is reported under. */
  report: Reporter;
  /** The step that went on without the chunk, also the metric's reason. */
  step: string;
  /** What the chunk's load threw. */
  error: unknown;
};

/** Reports a lazy chunk its caller went on without: a breadcrumb and one outcome metric naming the step. Never throws. */
export function reportLazyMiss({ report, step, error }: Params): void {
  report.expected(error, { step, metric: lazyChunkLoadMetric, reason: step });
}
