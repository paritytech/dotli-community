// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { formatLatency } from './formatLatency.js';
import type { StoredEvent } from './storedEvent.js';

/** The time from `first` to the group's last event, or null for a group of one. Never throws. */
export function formatGroupDuration(first: StoredEvent | undefined, group: readonly StoredEvent[]): string | null {
  const last = group.at(-1);
  if (first === undefined || last === undefined || first.seq === last.seq) {
    return null;
  }
  return formatLatency(last.receivedAt - first.receivedAt);
}
