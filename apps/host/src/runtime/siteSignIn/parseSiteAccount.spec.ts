// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { describe, expect, it } from 'vitest';
import { parseSiteAccount } from './parseSiteAccount.js';

const NETWORK: Network = 'paseo-next-v2';
const TLD = NETWORK_NAME_TO_SERVICES_CONFIG[NETWORK].dotns.TLD;
const PRODUCT = `myapp.${TLD}`;
const RAW: `0x${string}` = `0x${'Ab'.repeat(32)}`;

describe('site account', () => {
  it('As a site, I name my product account by number and the window reads it as an index', () => {
    // Given accounts named by the smallest and the largest number
    const names = [`${PRODUCT}/0`, `${PRODUCT}/4294967295`];

    // When they are parsed
    const parsed = names.map(name => parseSiteAccount(name, NETWORK));

    // Then each is an index of that number
    expect(parsed).toEqual([
      { dotNsIdentifier: PRODUCT, derivationIndex: { tag: 'Index', value: 0 } },
      { dotNsIdentifier: PRODUCT, derivationIndex: { tag: 'Index', value: 4294967295 } },
    ]);
  });

  it('As a site, I name my product account by a raw index and the window reads it as raw', () => {
    // Given an account named by a 32-byte hex index
    const name = `${PRODUCT}/${RAW}`;

    // When it is parsed
    const parsed = parseSiteAccount(name, NETWORK);

    // Then the index is raw and kept as given
    expect(parsed).toEqual({ dotNsIdentifier: PRODUCT, derivationIndex: { tag: 'Raw', value: RAW } });
  });

  it('As a site, I send a malformed account and the window refuses it', () => {
    // Given values that are not an account of this network
    const bad: unknown[] = [
      42,
      '',
      PRODUCT,
      `${PRODUCT}/`,
      `${PRODUCT}/01`,
      `${PRODUCT}/-1`,
      `${PRODUCT}/4294967296`,
      `${PRODUCT}/1.5`,
      `${PRODUCT}/0x${'ab'.repeat(31)}`,
      `myapp.${NETWORK_NAME_TO_SERVICES_CONFIG.previewnet.dotns.TLD}/0`,
      'myapp/0',
      `a.${TLD}/0`,
      'localhost:3000/0',
      `${PRODUCT}/0/1`,
    ];

    // When each is parsed
    const parsed = bad.map(value => parseSiteAccount(value, NETWORK));

    // Then every one is refused
    expect(parsed).toEqual(bad.map(() => null));
  });
});
