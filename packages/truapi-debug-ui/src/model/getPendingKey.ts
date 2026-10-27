// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A row's latency appears only once its reply lands, so without this a hung call looks like a fast one.
// Scoped to TrUAPI because answering those calls is where the host actually stalls.

import { isRequestTag } from './callTag.js';
import { getCallKey } from './getCallKey.js';
import type { StoredEvent } from './storedEvent.js';

/** The call key a TrUAPI request waits under, or null for any other event. Never throws. */
export function getPendingKey(event: StoredEvent): string | null {
  if (event.kind !== 'truapi' || !isRequestTag(event.tag)) {
    return null;
  }
  return getCallKey(event);
}
