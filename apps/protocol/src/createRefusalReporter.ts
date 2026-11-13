// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the protocol iframe reports the calls its handlers refuse or fail, for operators reading logs and the rejection
// counts. The host still hears each call's failure as the call's answer.

import { defineCount, type CountSink } from '@dotli/metrics';

import { FRAME_LOG_TAG } from './frameLogTag.js';
import { InvalidInputError } from './invalidInputError.js';
import type { FrameRefusal } from './withRefusalReports.js';

/**
 * Shared-storage request refused or failed. Tagged `store`, and `reason`: `validation` for a site or key that does not
 * check, which never touches `localStorage`, or else the storage error's name. Counted because the failed answer the
 * caller receives is easy to miss.
 */
const sharedStorageRejectedMetric = defineCount('shared_storage.rejected');

type Params = {
  /** Logs a store call the browser's storage failed, and every wallet or chain call that failed. */
  warn: (...args: unknown[]) => void;
  /** Counts a refused call of the shared stores. */
  count: CountSink;
};

/** Logs or counts each refusal by its route. The reporter throws what `warn` or `count` throws. */
export function createRefusalReporter({ warn, count }: Params): (refusal: FrameRefusal) => void {
  return reportRefusal;

  function reportRefusal(refusal: FrameRefusal): void {
    const { route, method, error } = refusal;
    switch (route) {
      case 'auth':
      case 'mode':
        if (error instanceof InvalidInputError) {
          count(sharedStorageRejectedMetric, { store: route, reason: 'validation' });
          return;
        }
        // The browser refused the storage, which the caller's input cannot cause, so its error is logged too.
        warn(`${FRAME_LOG_TAG} ${method} failed`, error);
        count(sharedStorageRejectedMetric, { store: route, reason: error.name });
        return;
      case 'wallet':
      case 'chain':
        // A log line only. The failure still reaches the host as the call's answer.
        warn(`${FRAME_LOG_TAG} ${method} failed`, error);
        return;
    }
  }
}
