// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the transport's parts share: the handshake, the calls this side makes and the calls it serves.

import type { Codec, ResultPayload } from 'scale-ts';
import type { Address } from './schema.js';
import { encode, type Frame } from './wire.js';

/**
 * Posts bytes, of the call at `address` when they belong to one. A post the provider throws on is already reported
 * when it returns the error.
 */
export type Post = (data: ArrayBuffer, address?: Address) => ResultPayload<undefined, Error>;

/** Reports a message that does not decode, or does not fit what it names. */
export type Refuse = (reason: 'malformed' | 'invalid', cause: Error) => void;

// The peer may still send on a call this side ended until it hears the end, so a message on a call ended lately is a
// race and quiet. The ids of this many of the latest ends are kept.
export const REMEMBERED_ENDS = 1_024;

/** Encodes a message on call `id` of the method at `address`, or says why it cannot. */
export function encodeCall<M>(
  method: { readonly frame: Codec<Frame<M>> },
  address: Address,
  id: number,
  message: M,
): ResultPayload<ArrayBuffer, Error> {
  const call = { trait: address.traitId, method: address.methodId, message };
  return encode(method.frame, { id, body: { tag: 'call', value: call } });
}

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
