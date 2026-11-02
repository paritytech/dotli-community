// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getErrorMessage } from '../getErrorMessage.js';

/**
 * How `wait` settled: `'resolved'`, or the message it rejected with. Never rejects. The handler is bound at once, so a
 * rejection is never unhandled.
 */
export function readOutcome(wait: Promise<unknown>): Promise<string> {
  return wait.then(() => 'resolved', getErrorMessage);
}
