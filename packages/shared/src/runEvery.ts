// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { combineErrors } from './combineErrors.js';

/**
 * Runs every step, even past one that throws, then throws the one `Error`, or an AggregateError of all of them with
 * `message`. Returns when no step threw.
 *
 * @example
 * runEvery(
 *   connections.map(connection => () => {
 *     connection.close();
 *   }),
 *   'closing every connection failed',
 * );
 */
export function runEvery(steps: readonly (() => void)[], message: string): void {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw combineErrors(errors, message);
  }
}
