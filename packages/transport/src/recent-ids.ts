// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The peer may still send on a call this side ended until it hears the end, so a message on a call ended lately is a
// race and quiet. The ids of this many of the latest ends are kept, so the record stays bounded on a long-lived
// transport.
export const REMEMBERED_ENDS = 1_024;

/** The ids of the calls this side ended lately. */
export interface RecentIds {
  add(id: number): void;
  has(id: number): boolean;
  delete(id: number): void;
}

export function createRecentIds(): RecentIds {
  // A set iterates in insertion order, so its first id is the oldest.
  const ids = new Set<number>();
  return {
    add(id) {
      ids.delete(id);
      ids.add(id);
      if (ids.size > REMEMBERED_ENDS) {
        const [oldest] = ids;
        if (oldest !== undefined) {
          ids.delete(oldest);
        }
      }
    },
    has: id => ids.has(id),
    delete(id) {
      ids.delete(id);
    },
  };
}
