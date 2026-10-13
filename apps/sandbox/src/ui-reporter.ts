// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What ui reports through on this page: the sandbox's metrics. The overlays pass it on to their mount.

import { captureException, reportExpected, spans as S } from '@dotli/metrics';
import type { Reporter } from '@dotli/ui-core';

export const uiReporter: Reporter = {
  failure: captureException,
  // ui's only expected miss is a lazy chunk that failed to preload.
  expected: (err, context) => {
    reportExpected(err, { ...context, metric: S.LAZY_CHUNK_LOAD });
  },
};

/** A page chunk that failed to load is left as a breadcrumb, since the caller that imported it reports the failure. */
export function reportChunkFailure(error: unknown): void {
  reportExpected(error, { flow: 'boot', step: 'chunk_preload', metric: S.CHUNK_PRELOAD });
}
