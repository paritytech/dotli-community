// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dotNS lists the addresses of its contracts in a protocol registry, whose own address the Registry holds.

import type { DotnsContracts } from '@dotli/config';
import { toHex } from '@dotli/shared';
import type { Api } from './createRawApi.js';
import { computeMappingSlot, decodeAddress, encodeSlotKey } from './storageSlots.js';

type Params = {
  api: Api;
  dotns: DotnsContracts;
  /** A block a `withBestBlock` read holds. */
  atHash: string;
  /** The name the protocol registry lists the contract under. */
  contract: 'registrar' | 'reverseResolver';
};

/**
 * Reads the address of a dotNS contract from the protocol registry at `atHash`, in lowercase hex. Resolves `null` when
 * the Registry holds no protocol registry or the registry lists no such contract. Rejects with the error of the slot
 * read that failed.
 */
export async function readProtocolAddress({ api, dotns, atHash, contract }: Params): Promise<string | null> {
  const registrySlot = encodeSlotKey(dotns.STORAGE_SLOTS.REGISTRY_PROTOCOL_REGISTRY);
  const protocolRegistry = decodeAddress(await api.readSlot(dotns.DOTNS_REGISTRY, registrySlot, { atHash }));
  if (protocolRegistry === null) {
    return null;
  }
  // The registry keys a contract by `bytes32` of its name: the ASCII, right-padded with zeros.
  const key = new Uint8Array(32);
  key.set(new TextEncoder().encode(contract));
  const addressSlot = computeMappingSlot(toHex(key), dotns.STORAGE_SLOTS.PROTOCOL_REGISTRY_ADDRESSES);
  return decodeAddress(await api.readSlot(protocolRegistry, addressSlot, { atHash }));
}
