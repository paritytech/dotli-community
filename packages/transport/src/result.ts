// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// truapi's `Result`, which is scale-ts's own.

import type { ResultPayload } from 'scale-ts';

/** Wraps a value as a success. Called with no argument it is the success of a call that returns nothing. */
export function ok(): ResultPayload<undefined, never>;
export function ok<Value>(value: Value): ResultPayload<Value, never>;
export function ok<Value>(value?: Value): ResultPayload<Value | undefined, never> {
  return { success: true, value };
}

/** Wraps an error as a failure. */
export function err<ErrorValue>(error: ErrorValue): ResultPayload<never, ErrorValue> {
  return { success: false, value: error };
}
