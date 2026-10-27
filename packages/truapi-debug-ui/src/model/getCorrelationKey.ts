// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredEvent } from './storedEvent.js';

/** The key an event groups by: a TrUAPI message's request id, or a host event's flow id. Never throws. */
export function getCorrelationKey(event: StoredEvent): string {
  switch (event.kind) {
    case 'truapi':
      return event.requestId;
    case 'system':
      return event.flowId;
  }
}
