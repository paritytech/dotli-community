// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The storage keys of a Revive contract, as `ReviveApi::get_storage` reads them: the contract's `trie_id` from
// `AccountInfoOf` in the main trie, then each slot from that child trie.

import { Twox128, Blake2256, Hex } from '@polkadot-api/substrate-bindings';
import { mergeUint8 } from '@polkadot-api/utils';
import { fromHex, toHex } from '@dotli/shared';

const encoder = new TextEncoder();

const ACCOUNT_INFO_OF_PREFIX = mergeUint8([
  Twox128(encoder.encode('Revive')),
  Twox128(encoder.encode('AccountInfoOf')),
]);

const decodeVecU8 = Hex().dec;

/** The main trie key of a contract's `AccountInfoOf` entry. */
export function getAccountInfoKey(contractAddress: string): `0x${string}` {
  // `AccountInfoOf` uses the Identity hasher.
  return toHex(mergeUint8([ACCOUNT_INFO_OF_PREFIX, fromHex(contractAddress)]));
}

/** The `trie_id` an `AccountInfoOf` value holds, or `null` when the account is not a contract. */
export function decodeTrieId(accountInfoHex: string): Uint8Array | null {
  const accountInfo = fromHex(accountInfoHex);
  // Tag 0x00 is `Contract(ContractInfo)`, whose first field is `trie_id` as a SCALE `Vec<u8>`.
  if (accountInfo[0] !== 0x00) {
    return null;
  }
  return fromHex(decodeVecU8(accountInfo.slice(1)));
}

/** The child trie key of a contract slot. */
export function getChildSlotKey(slotKey: `0x${string}`): `0x${string}` {
  return toHex(Blake2256(fromHex(slotKey)));
}
