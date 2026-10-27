// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The peer may still send on a call this side ended until it hears the end, so a message on a call ended lately is a
// race and quiet. The ids of this many of the latest ends are kept, so the record stays bounded on a long-lived
// transport.
export const REMEMBERED_ENDS = 1_024;

/** The ids of the calls this side ended lately, at most `REMEMBERED_ENDS` of them. */
export function createRecentIds() {
  // A set iterates in insertion order, so its first id is the oldest.
  const ids = new Set<number>();
  return {
    /** Records `id` as the latest, forgetting the oldest once more than `REMEMBERED_ENDS` are kept. */
    add(id: number): void {
      ids.delete(id);
      ids.add(id);
      if (ids.size > REMEMBERED_ENDS) {
        const [oldest] = ids;
        if (oldest !== undefined) {
          ids.delete(oldest);
        }
      }
    },
    /** Whether `id` is one of the ids kept. */
    has(id: number): boolean {
      return ids.has(id);
    },
    /** Forgets `id`. */
    delete(id: number): void {
      ids.delete(id);
    },
  };
}
