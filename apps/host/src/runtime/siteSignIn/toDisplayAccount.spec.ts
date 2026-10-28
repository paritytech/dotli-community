// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import type { ProductAccountId } from '@parity/truapi';
import { describe, expect, it } from 'vitest';
import { toDisplayAccount } from './toDisplayAccount.js';

const NETWORK: Network = 'paseo-next-v2';
const PRODUCT = `myapp.${NETWORK_NAME_TO_SERVICES_CONFIG[NETWORK].dotns.TLD}`;
const RAW: `0x${string}` = `0x${'Ab'.repeat(32)}`;

describe('the account a site names, as the user sees it', () => {
  it('As a user, I see the account a site named and it reads as the site wrote it', () => {
    // Given an index account and a raw account
    const index: ProductAccountId = { dotNsIdentifier: PRODUCT, derivationIndex: { tag: 'Index', value: 0 } };
    const raw: ProductAccountId = { dotNsIdentifier: PRODUCT, derivationIndex: { tag: 'Raw', value: RAW } };

    // When they are displayed
    const shown = [index, raw].map(account => toDisplayAccount(account));

    // Then the product and the index read as written
    expect(shown).toEqual([
      { product: PRODUCT, index: '0' },
      { product: PRODUCT, index: RAW },
    ]);
  });
});
