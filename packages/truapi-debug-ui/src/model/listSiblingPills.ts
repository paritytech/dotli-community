// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so it runs under Node. Returns plain data that the components render as JSX text.

import { formatLatency } from './formatLatency.js';
import { getEventLabel } from './getEventLabel.js';
import type { EventSeq, StoredEvent } from './storedEvent.js';

type SiblingPill = {
  seq: EventSeq;
  label: string;
  title: string;
};

type Params = {
  /** The event the pills are offset from. */
  event: StoredEvent;
  /** The group's first event, which each title counts from. */
  first: StoredEvent | undefined;
  siblings: StoredEvent[];
};

/**
 * One pill per sibling of `event`, labelled with its offset from `event` and titled with its offset from `first`. Never
 * throws.
 */
export function listSiblingPills({ event, first, siblings }: Params): SiblingPill[] {
  return siblings.map(sibling => {
    const deltaMs = first === undefined ? 0 : sibling.receivedAt - first.receivedAt;
    const sign = event.receivedAt > sibling.receivedAt ? '−' : '+';
    const offset = `${sign}${formatLatency(Math.abs(sibling.receivedAt - event.receivedAt))}`;
    return {
      seq: sibling.seq,
      label: `${getEventLabel(sibling)} ${offset}`,
      title: `seq ${String(sibling.seq)} · +${formatLatency(deltaMs)} from start`,
    };
  });
}
