// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatLatency } from './formatLatency.js';
import type { StoredEvent } from './storedEvent.js';

/** `+12ms` from the group's first event, or null for the first event itself. Never throws. */
export function formatMemberDelta(member: StoredEvent, first: StoredEvent | undefined): string | null {
  if (first === undefined || first.seq === member.seq) {
    return null;
  }
  return `+${formatLatency(member.receivedAt - first.receivedAt)}`;
}
