// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a site's round runs over in a spec: the site, its grants' tokens, the window's clock and the main account.

import { base64urlnopad } from '@scure/base';
import { fromHex, hashBlake2b, toHex } from '@dotli/shared';
import type { MainAccount } from '../runtime/siteSignIn/createMainAccountSource.js';

/** The site's origin. */
export const SITE_ORIGIN = 'https://my-site.com';
/** The token of the grant the main store keeps for the site. */
export const SITE_TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(1));
/** The token a new grant gets. */
export const NEW_SITE_TOKEN = base64urlnopad.encode(new Uint8Array(32).fill(2));
/** The window's clock. */
export const ROUND_NOW = Date.parse('2026-10-23T15:00:00.000Z');

/** The main account's public key, as `0x` hex. */
export const MAIN_KEY = `0x${'a'.repeat(64)}`;
/** The owner of the main account's grants. */
export const MAIN_OWNER = toHex(hashBlake2b(fromHex(MAIN_KEY), 32));
/** The main account the window's core reports. */
export const MAIN_ACCOUNT: MainAccount = { owner: MAIN_OWNER, username: { name: 'alice.dot', kind: 'full' } };
