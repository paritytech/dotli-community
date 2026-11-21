// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The ReverseResolver lets any address store any name as its primary name. A name is the address's own only while the
// address owns it in dotNS, so the read checks the name's forward owner before it returns the name.

import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import { readNameOwner } from './readNameOwner.js';
import { readPinnedBytes } from './readPinnedBytes.js';
import { readProtocolAddress } from './readProtocolAddress.js';
import { computeMappingSlot } from './storageSlots.js';

type Params = {
  api: Api;
  dotns: DotnsContracts;
  /** A `0x`-prefixed 20-byte address, in any case. */
  address: string;
};

/**
 * Reads an address's dotNS primary name, such as `alice.dot`, once the name's owner is confirmed to be that address.
 * Resolves `null` when the address stored no name, the stored name is empty, not UTF-8 or not under the network's TLD,
 * or another address owns it. Rejects with `PartialStorageReadError` when the name's read stops partway,
 * `CorruptBytesSlotError` when its stored length cannot be read, and otherwise with the error of the slot read that
 * failed.
 */
export function readPrimaryName({ api, dotns, address }: Params): Promise<string | null> {
  const owner = address.toLowerCase();
  const suffix = `.${dotns.TLD}`;
  return api.withBestBlock(async atHash => {
    // The reads below each pin a block of their own. Handed this view, they read at the block this read holds, so the
    // name and its owner come from one state.
    const pinned: Api = { ...api, withBestBlock: read => read(atHash) };
    const reverseResolver = await readProtocolAddress({ api, dotns, atHash, contract: 'reverseResolver' });
    if (reverseResolver === null) {
      return null;
    }
    // The mapping keys an address as a word, left-padded with zeros.
    const key: `0x${string}` = `0x${owner.slice(2).padStart(64, '0')}`;
    const name = decodeName(
      await readPinnedBytes({
        api: pinned,
        contractAddress: reverseResolver,
        baseSlotKey: computeMappingSlot(key, dotns.STORAGE_SLOTS.REVERSE_RESOLVER_NAMES),
        context: { mappingKind: 'mapping string' },
      }),
    );
    if (name === null || !name.endsWith(suffix) || name.length === suffix.length) {
      return null;
    }
    const nameOwner = await readNameOwner({ api: pinned, dotns, label: name.slice(0, -suffix.length) });
    return nameOwner === owner ? name : null;
  });
}

function decodeName(bytes: Uint8Array | null): string | null {
  if (bytes === null) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    // A fatal decoder rejects bytes that are not UTF-8 with a TypeError, and such bytes name nothing.
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}
