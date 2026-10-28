// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the protocol iframe reports the calls its handlers refuse or fail, for operators reading logs and the rejection
// counts. The host still hears each call's failure as the call's answer.

import { spans as S, type m } from '@dotli/metrics';

import { FRAME_LOG_TAG } from './frameLogTag.js';
import type { FrameRefusal } from './withRefusalReports.js';

type Params = {
  /** Logs a refused or failed call of the wallet or the chains. */
  warn: (...args: unknown[]) => void;
  /** Counts a refused call of the shared stores. */
  count: typeof m.count;
};

/** Logs or counts each refusal by its route. The reporter throws what `warn` or `count` throws. */
export function createRefusalReporter({ warn, count }: Params): (refusal: FrameRefusal) => void {
  return reportRefusal;

  function reportRefusal(refusal: FrameRefusal): void {
    const { route } = refusal;
    switch (route) {
      case 'auth':
      case 'mode':
        count(S.SHARED_STORAGE_REJECTED, { store: route, reason: 'validation' });
        return;
      case 'wallet':
      case 'chain':
        // A log line only. The failure still reaches the host as the call's answer.
        warn(`${FRAME_LOG_TAG} ${refusal.method} failed`, refusal.error);
        return;
    }
  }
}
