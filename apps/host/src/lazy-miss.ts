// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { reportExpected, spans as S, type CaptureContext } from '@dotli/metrics';

/** Reports a lazy chunk its caller went on without: a breadcrumb and one outcome metric naming the step. */
export function reportLazyMiss(flow: CaptureContext['flow'], step: string, err: unknown): void {
  reportExpected(err, { flow, step, metric: S.LAZY_CHUNK_LOAD, reason: step });
}
