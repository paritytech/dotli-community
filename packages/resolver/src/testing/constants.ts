// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A stand-in contract address. */
export const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000001';

/** `Revive::AccountInfoOf` for a contract whose child trie id is `0x01`. */
export const CONTRACT_ACCOUNT_INFO = '0x000401';

/** A root manifest every field check accepts. */
export const VALID_ROOT = {
  $v: 1,
  displayName: 'HackM3',
  description: 'A note-taking app',
  icon: { cid: 'bafy...icon', format: 'png' },
};
