// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Api } from './createRawApi.js';
import { computeMappingSlot, extractAddress } from './storageSlots.js';

type Params = {
  api: Api;
  contractAddress: string;
  mappingKey: `0x${string}`;
  mappingSlot: number;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Reads a `mapping(bytes32 => address)` value, or `null` when it is unset or the zero address. */
export async function readMappingAddress({
  api,
  contractAddress,
  mappingKey,
  mappingSlot,
}: Params): Promise<string | null> {
  // A single slot cannot tear, so no pin.
  const slotKey = computeMappingSlot(mappingKey, mappingSlot);
  const data = await api.readSlot(contractAddress, slotKey);
  if (data === null) {
    return null;
  }
  const address = extractAddress(data);
  if (address === ZERO_ADDRESS) {
    return null;
  }
  return address;
}
