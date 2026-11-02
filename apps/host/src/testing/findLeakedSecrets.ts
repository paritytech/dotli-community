// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the main store holds beside the main account, and the check that none of it reaches a site in what the window
// posts.

import { hex } from '@scure/base';
import { MAIN_KEY, MAIN_OWNER } from './siteRoundConstants.js';
import { writeMessages } from './writeMessages.js';

/** The paired session the main store keeps. */
export const MAIN_BLOB = 'MAIN-SESSION-BLOB';
/** The entropy of the local wallet the main store keeps. */
export const WALLET_ENTROPY = new Uint8Array(16).fill(0x5c);
/** The identity account of the local wallet the main store keeps. */
export const WALLET_ACCOUNT = '5LocalWalletIdentityAccountOfTheMainStore';

/** What the main store holds that no site may ever get, as a message to the site would spell it. */
const MAIN_STORE_SECRETS = [MAIN_BLOB, MAIN_KEY.slice(2), hex.encode(WALLET_ENTROPY), WALLET_ACCOUNT, MAIN_OWNER];

/** The messages that carry any of the main store's secrets, as JSON text. Empty when none leaks. */
export function findLeakedSecrets(messages: readonly unknown[]): string[] {
  return writeMessages(messages).filter(message => MAIN_STORE_SECRETS.some(secret => message.includes(secret)));
}
