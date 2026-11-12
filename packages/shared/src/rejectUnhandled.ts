// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toError } from './toError.js';

/**
 * Hands a defect of a unit in this package to the context's global handlers as an unhandled rejection, since the
 * package has no reporter. Never throws.
 */
export function rejectUnhandled(error: unknown): void {
  void Promise.reject(toError(error));
}
