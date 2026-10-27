// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Api } from './createRawApi.js';
import { readPinnedBytes } from './readPinnedBytes.js';
import { computeMappingSlot } from './storageSlots.js';
import { withPinnedContract, type PinnedContract } from './withPinnedContract.js';

type Params = {
  api: Api;
  contractAddress: string;
  mappingKey: `0x${string}`;
  mappingSlot: number;
};

/** Reads a `mapping(bytes32 => bytes)` value, or `null` when unset. Throws when a read stops partway. */
export function readMappingBytes(params: Params): Promise<Uint8Array | null> {
  return withPinnedContract({
    api: params.api,
    contractAddress: params.contractAddress,
    read: pin => readPinnedMappingBytes(params, pin),
  });
}

function readPinnedMappingBytes(
  { api, contractAddress, mappingKey, mappingSlot }: Params,
  pin: PinnedContract,
): Promise<Uint8Array | null> {
  return readPinnedBytes({
    api,
    contractAddress,
    baseSlotKey: computeMappingSlot(mappingKey, mappingSlot),
    pin,
    context: { mappingKind: 'mapping bytes' },
  });
}
