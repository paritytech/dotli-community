// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product's HTML inlines this bundled, so it imports only types.

import type { ApiViolationMessage } from '@dotli/sandbox-wire';

/** Reports one use of `api`, with `details`, what is known about it. Never throws. */
export type ReportViolation = (api: string, options?: { details?: Record<string, unknown> }) => void;

/** A reporter that posts each violation to `page`'s parent. Never throws. */
export function createParentReporter(page: Pick<Window, 'parent'>): ReportViolation {
  return reportViolation;

  function reportViolation(api: string, { details }: { details?: Record<string, unknown> } = {}): void {
    try {
      const message: ApiViolationMessage = {
        type: 'DOTLI_API_VIOLATION',
        api,
        details: details ?? {},
        timestamp: Date.now(),
      };
      page.parent.postMessage(message, '*');
      // eslint-disable-next-line no-restricted-syntax -- a product page has no reporter of its own, and a failed report must not fail the product's call.
    } catch {
      // Not reported.
    }
  }
}
