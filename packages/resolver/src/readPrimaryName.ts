// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The ReverseResolver lets any address store any name as its primary name. A name is the address's own only while the
// address owns it in dotNS, so the read checks the name's forward owner before it returns the name.

import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import { isValidDotName } from './dotLabel.js';
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
 * Resolves `null` when the address is not 20 bytes of hex, stored no name, or stored a name that is not UTF-8, not
 * under the network's TLD, not valid by the naming rules or owned by another address. Rejects with
 * `PartialStorageReadError` when the name's read stops partway, `CorruptBytesSlotError` when its stored length cannot be
 * read, and otherwise with the error of the slot read that failed.
 */
export function readPrimaryName({ api, dotns, address }: Params): Promise<string | null> {
  const owner = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner)) {
    return Promise.resolve(null);
  }
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
    if (name?.endsWith(suffix) !== true) {
      return null;
    }
    // The ReverseResolver stores any text. A label outside the naming rules, such as one with a lookalike letter or a
    // bidi control, could read as another name.
    const label = name.slice(0, -suffix.length);
    if (!isValidDotName(label)) {
      return null;
    }
    const nameOwner = await readNameOwner({ api: pinned, dotns, label });
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
