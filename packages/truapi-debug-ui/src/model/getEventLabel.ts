// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredEvent } from './storedEvent.js';

/** Returns a kept event's label, its TrUAPI tag or `layer.event` for a host event, and never throws. */
export function getEventLabel(event: StoredEvent): string {
  switch (event.kind) {
    case 'truapi':
      return event.tag;
    case 'system':
      return `${event.layer}.${event.event}`;
  }
}
