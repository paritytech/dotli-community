// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Seity's slot registry, read from raw contract storage.
//
// The registry (paritytech/seity `registry/lib.rs`) keeps three
// `Mapping<(domain, lookupKey), _>` fields: owners (slot 0, right-aligned
// 20 bytes), digests (slot 1, bytes32) and versions (slot 2, uint64). The
// layout is pinned on both sides by the same storage keys (seity's
// `storage_layout_is_what_raw_readers_compute`, and this package's test). pvm-storage lays
// them out as Solidity nested mappings, so the resolver's slot maths applies
// and no runtime call is needed. Version 0 means never anchored; a zero
// digest means revoked.

import type { Api } from "./api";
import { computeNestedBytes32MappingSlot, toHex, wordToBigInt } from "./abi";

/** blake2b-256("seity:domain:v1"): the registry domain every seity slot uses. */
export const SEITY_REGISTRY_DOMAIN =
  "0x5c9584ba6e565351723d57394780b31b4c2156123e1269c4724ae5f01258bb53" as const;

const SLOT_OWNERS = 0;
const SLOT_DIGESTS = 1;
const SLOT_VERSIONS = 2;

export interface SeitySlot {
  /** Right-aligned in its word, like an `address` (pinned by seity's registry layout test). */
  readonly owner: `0x${string}`;
  readonly cidDigest: `0x${string}`;
  readonly version: bigint;
}

export async function readSeitySlot(
  api: Api,
  registry: string,
  lookupKey: `0x${string}`,
  domain: `0x${string}` = SEITY_REGISTRY_DOMAIN,
): Promise<SeitySlot | null> {
  return api.withContract(registry, async (storage) => {
    const slot = (n: number): `0x${string}` =>
      computeNestedBytes32MappingSlot(domain, lookupKey, n);
    const versionWord = await storage.readSlot(slot(SLOT_VERSIONS));
    const version = versionWord === null ? 0n : wordToBigInt(versionWord);
    if (version === 0n) {
      return {
        owner: `0x${"00".repeat(20)}`,
        cidDigest: `0x${"00".repeat(32)}`,
        version,
      };
    }
    const [ownerWord, digestWord] = await Promise.all([
      storage.readSlot(slot(SLOT_OWNERS)),
      storage.readSlot(slot(SLOT_DIGESTS)),
    ]);
    return {
      owner: toHex((ownerWord ?? new Uint8Array(32)).slice(12)),
      cidDigest: toHex(digestWord ?? new Uint8Array(32)),
      version,
    };
  });
}
