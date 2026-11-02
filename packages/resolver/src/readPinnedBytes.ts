// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Api } from './createRawApi.js';
import { PartialStorageReadError } from './partialStorageReadError.js';
import { addToSlot, decodeBytesSlot } from './storageSlots.js';
import type { PinnedContract } from './withPinnedContract.js';

type Params = {
  api: Api;
  contractAddress: string;
  baseSlotKey: `0x${string}`;
  pin: PinnedContract;
  /** What the error names when a data slot is missing. */
  context: PartialStorageReadError['context'];
};

/**
 * Reads a Solidity `bytes` value at `baseSlotKey` on the pinned block, resolving `null` when it is unset. Rejects with
 * `PartialStorageReadError` when a data slot is missing, and otherwise with `Api.readSlot`'s error.
 */
export async function readPinnedBytes({
  api,
  contractAddress,
  baseSlotKey,
  pin,
  context,
}: Params): Promise<Uint8Array | null> {
  const baseData = await api.readSlot(contractAddress, baseSlotKey, { atHash: pin.hash, trieId: pin.trieId });
  if (baseData === null) {
    return null;
  }
  const decoded = decodeBytesSlot(baseData, baseSlotKey);
  if (decoded === null) {
    return null;
  }
  if (decoded.inline) {
    return decoded.data;
  }
  const slotsNeeded = Math.ceil(decoded.length / 32);
  const result = new Uint8Array(decoded.length);
  for (let index = 0; index < slotsNeeded; index++) {
    const slotKey = addToSlot(decoded.dataSlot, index);
    const slotData = await api.readSlot(contractAddress, slotKey, { atHash: pin.hash, trieId: pin.trieId });
    // Zero-padding the gap would yield a corrupt contenthash that reads as "name not found".
    if (slotData === null) {
      throw new PartialStorageReadError({
        contractAddress,
        slotIndex: index,
        slotsExpected: slotsNeeded,
        context,
      });
    }
    const offset = index * 32;
    const copyLength = Math.min(32, decoded.length - offset);
    result.set(slotData.slice(0, copyLength), offset);
  }
  return result;
}
