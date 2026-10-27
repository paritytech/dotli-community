// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getFailureReason } from './getFailureReason.js';

/** The peer's answer to a request does not decode, so the call has no outcome. `cause` is why. */
export class TransportMalformedResponseError extends Error {
  constructor(call: { section: string; method: string }, cause: Error) {
    super(`The answer to ${call.section}.${call.method} does not decode, ${getFailureReason(cause)}`, { cause });
    this.name = 'TransportMalformedResponseError';
  }
}
