// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Turns a rejection into a value, so a test asserts on it without a try block.

import { toError } from '@dotli/shared';

/** Settles a promise into a value: `{ value }` when it resolved, or the error it rejected with. */
export async function captureOutcome<Value>(promise: Promise<Value>): Promise<{ value: Value } | Error> {
  return promise.then(
    value => ({ value }),
    (error: unknown) => toError(error),
  );
}
