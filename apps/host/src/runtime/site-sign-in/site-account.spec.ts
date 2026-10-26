// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import type { ProductAccountId } from '@parity/truapi';
import { describe, expect, it } from 'vitest';
import { displayAccount, parseSiteAccount } from './site-account.js';

const net: Network = 'paseo-next-v2';
const tld = NETWORK_NAME_TO_SERVICES_CONFIG[net].dotns.TLD;
const product = `myapp.${tld}`;
const RAW: `0x${string}` = `0x${'Ab'.repeat(32)}`;

describe('site account', () => {
  it('As a site, I name my product account by number and the window reads it as an index', () => {
    // Given accounts named by the smallest and the largest number
    const names = [`${product}/0`, `${product}/4294967295`];

    // When they are parsed
    const parsed = names.map(name => parseSiteAccount(name, net));

    // Then each is an index of that number
    expect(parsed).toEqual([
      { dotNsIdentifier: product, derivationIndex: { tag: 'Index', value: 0 } },
      { dotNsIdentifier: product, derivationIndex: { tag: 'Index', value: 4294967295 } },
    ]);
  });

  it('As a site, I name my product account by a raw index and the window reads it as raw', () => {
    // Given an account named by a 32-byte hex index
    const name = `${product}/${RAW}`;

    // When it is parsed
    const parsed = parseSiteAccount(name, net);

    // Then the index is raw and kept as given
    expect(parsed).toEqual({ dotNsIdentifier: product, derivationIndex: { tag: 'Raw', value: RAW } });
  });

  it('As a site, I send a malformed account and the window refuses it', () => {
    // Given values that are not an account of this network
    const bad: unknown[] = [
      42,
      '',
      product,
      `${product}/`,
      `${product}/01`,
      `${product}/-1`,
      `${product}/4294967296`,
      `${product}/1.5`,
      `${product}/0x${'ab'.repeat(31)}`,
      `myapp.${NETWORK_NAME_TO_SERVICES_CONFIG.previewnet.dotns.TLD}/0`,
      'myapp/0',
      `a.${tld}/0`,
      'localhost:3000/0',
      `${product}/0/1`,
    ];

    // When each is parsed
    const parsed = bad.map(value => parseSiteAccount(value, net));

    // Then every one is refused
    expect(parsed.every(result => result === null)).toBe(true);
  });

  it('As the window, I show the account a site named and it reads as the site wrote it', () => {
    // Given an index account and a raw account
    const index: ProductAccountId = { dotNsIdentifier: product, derivationIndex: { tag: 'Index', value: 0 } };
    const raw: ProductAccountId = { dotNsIdentifier: product, derivationIndex: { tag: 'Raw', value: RAW } };

    // When they are displayed
    const shown = [index, raw].map(account => displayAccount(account));

    // Then the product and the index read as written
    expect(shown).toEqual([
      { product, index: '0' },
      { product, index: RAW },
    ]);
  });
});
