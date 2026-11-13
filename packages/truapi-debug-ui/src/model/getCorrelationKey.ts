// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getCallKey } from './getCallKey.js';
import type { StoredEvent } from './storedEvent.js';

/** The key an event groups by: a TrUAPI message's call, or a host event's flow id. */
export function getCorrelationKey(event: StoredEvent): string {
  switch (event.kind) {
    case 'truapi':
      return getCallKey(event);
    case 'system':
      return event.flowId;
  }
}
