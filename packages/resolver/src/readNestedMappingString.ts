// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Api } from './createRawApi.js';
import { readPinnedBytes } from './readPinnedBytes.js';
import { computeNestedStringMappingSlot } from './storageSlots.js';
import { withPinnedContract, type PinnedContract } from './withPinnedContract.js';

type Params = {
  api: Api;
  contractAddress: string;
  outerKey: `0x${string}`;
  innerKey: string;
  outerSlot: number;
};

/** Reads a dotNS text record, keyed by namehash and then record name. Throws when a read stops partway. */
export function readNestedMappingString(params: Params): Promise<string | null> {
  return withPinnedContract({
    api: params.api,
    contractAddress: params.contractAddress,
    read: pin => readPinnedNestedMappingString(params, pin),
  });
}

async function readPinnedNestedMappingString(
  { api, contractAddress, outerKey, innerKey, outerSlot }: Params,
  pin: PinnedContract,
): Promise<string | null> {
  const bytes = await readPinnedBytes({
    api,
    contractAddress,
    baseSlotKey: computeNestedStringMappingSlot({ outerKey, innerKey, outerSlot }),
    pin,
    context: { mappingKind: 'nested string mapping', innerKey },
  });
  if (bytes === null) {
    return null;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
