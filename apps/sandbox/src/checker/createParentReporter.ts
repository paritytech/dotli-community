// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product's HTML inlines this bundled, so it imports only types.

import type { ApiViolationMessage } from '@dotli/sandbox-wire';

/** Reports one use of `api`, with `details`, what is known about it. Never throws. */
export type ReportViolation = (api: string, options?: { details?: Record<string, string> }) => void;

/** A reporter that posts each violation to `page`'s parent. Never throws. */
export function createParentReporter(page: Pick<Window, 'parent'>): ReportViolation {
  return reportViolation;

  function reportViolation(api: string, { details }: { details?: Record<string, string> } = {}): void {
    try {
      const message: ApiViolationMessage = {
        type: 'DOTLI_API_VIOLATION',
        api,
        details: details ?? {},
        timestamp: Date.now(),
      };
      page.parent.postMessage(message, '*');
    } catch (error) {
      // A failed report must not fail the product's call, and the product's page has no reporter of its own.
      // eslint-disable-next-line no-console -- the one trace a lost report leaves
      console.error(`The checker could not report a use of ${api}:`, error);
    }
  }
}
