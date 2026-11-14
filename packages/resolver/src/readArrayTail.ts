// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Api } from './createRawApi.js';
import { computeArrayElementSlot, encodeSlotKey, readWordAsBigInt } from './storageSlots.js';

type Params = {
  api: Api;
  contractAddress: string;
  /** The slot of a Solidity dynamic array, which holds its length. */
  slot: number;
  /** The first element to read. */
  from: number;
  /** The most elements to read. */
  limit?: number;
  at: { atHash: string; trieId: Uint8Array };
};

/**
 * The words of the array's elements from `from` on, at most `limit` of them, `null` for an unset one. No element is
 * read when the length is at or below `from`. Rejects with a slot read's error.
 */
export async function readArrayTail({
  api,
  contractAddress,
  slot,
  from,
  limit = Number.POSITIVE_INFINITY,
  at,
}: Params): Promise<(Uint8Array | null)[]> {
  const countWord = await api.readSlot(contractAddress, encodeSlotKey(slot), at);
  const count = countWord === null ? 0 : Number(readWordAsBigInt(countWord));
  const end = Math.min(count, from + limit);
  if (end <= from) {
    return [];
  }
  const elementSlots = Array.from({ length: end - from }, (_, offset) => computeArrayElementSlot(slot, from + offset));
  return api.readSlots(contractAddress, elementSlots, at);
}
