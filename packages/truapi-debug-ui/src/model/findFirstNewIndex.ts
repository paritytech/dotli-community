// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { EventSeq, StoredEvent } from './storedEvent.js';

/**
 * Index in `next` of the first event `previous` did not hold.
 * Events only leave from the head, so everything past `previous`'s last seq is new.
 * A caller reading the live buffer, which it cannot snapshot, passes `{ lastSeq }` (-1 for none).
 * Never throws.
 */
export function findFirstNewIndex(
  previous: readonly Pick<StoredEvent, 'seq'>[] | { readonly lastSeq: EventSeq },
  next: readonly Pick<StoredEvent, 'seq'>[],
): number {
  const lastSeen = 'lastSeq' in previous ? previous.lastSeq : previous.at(-1)?.seq;
  if (lastSeen === undefined) {
    return 0;
  }
  let index = next.length;
  while (index > 0) {
    const event = next[index - 1];
    if (event === undefined || event.seq <= lastSeen) {
      break;
    }
    index--;
  }
  return index;
}
