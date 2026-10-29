// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { reportExpected, spans as S, type CaptureContext } from '@dotli/metrics';

type Params = {
  flow: CaptureContext['flow'];
  /** The step that went on without the chunk, also the metric's reason. */
  step: string;
  /** What the chunk's load threw. */
  error: unknown;
};

/** Reports a lazy chunk its caller went on without: a breadcrumb and one outcome metric naming the step. Never throws. */
export function reportLazyMiss({ flow, step, error }: Params): void {
  reportExpected(error, { flow, step, metric: S.LAZY_CHUNK_LOAD, reason: step });
}
