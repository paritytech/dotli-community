// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Returns the one error when exactly one `Error` failed, and an `AggregateError` of all of them otherwise. Callers
 * pass at least one error. Never throws.
 */
export function combineErrors(errors: readonly unknown[], message: string): Error {
  const [only] = errors;
  if (errors.length === 1 && only instanceof Error) {
    return only;
  }
  return new AggregateError(errors, message);
}
