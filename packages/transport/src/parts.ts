// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the transport's parts share: the handshake, the calls this side makes and the calls it serves.

import type { CallError, Result } from './result.js';
import type { Leg } from './wire.js';

/** How a call ends: the peer's `Result`, or one the library gives it. */
export type Outcome = Result<unknown, CallError<unknown>>;

/** A schema method by its wire ids. */
export interface Address {
  trait: number;
  method: number;
}

/** Posts bytes. A post the provider throws on is already reported when it returns the error. */
export type Post = (data: ArrayBuffer, leg: Leg) => Result<void, unknown>;

/** Runs a callback of the owner's. One that throws is reported as `listener_threw`, and the transport carries on. */
export type RunListener = (listener: () => void) => void;

/** A record of ids that keeps only the latest `limit`, so it stays bounded on a long-lived transport. */
export interface RecentIds {
  add(id: number): void;
  has(id: number): boolean;
  delete(id: number): void;
}

export function createRecentIds(limit: number): RecentIds {
  // A set iterates in insertion order, so its first id is the oldest.
  const ids = new Set<number>();
  return {
    add(id) {
      ids.delete(id);
      ids.add(id);
      if (ids.size > limit) {
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
