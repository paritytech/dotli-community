// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toError } from '../toError.js';

/** The error `pending` rejects with. Rejects when `pending` resolves instead. */
export function catchRejection(pending: Promise<unknown>): Promise<Error> {
  return pending.then(() => {
    throw new Error('the promise resolved');
  }, toError);
}
