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
  at: { atHash: string; trieId: Uint8Array };
};

/**
 * The array's length, and the words of its elements from `from` on, `null` for an unset one. No element is read when
 * the length is at or below `from`. Rejects with a slot read's error.
 */
export async function readArrayTail({
  api,
  contractAddress,
  slot,
  from,
  at,
}: Params): Promise<{ count: number; words: (Uint8Array | null)[] }> {
  const countWord = await api.readSlot(contractAddress, encodeSlotKey(slot), at);
  const count = countWord === null ? 0 : Number(readWordAsBigInt(countWord));
  if (count <= from) {
    return { count, words: [] };
  }
  const elementSlots = Array.from({ length: count - from }, (_, offset) =>
    computeArrayElementSlot(slot, from + offset),
  );
  return { count, words: await api.readSlots(contractAddress, elementSlots, at) };
}
