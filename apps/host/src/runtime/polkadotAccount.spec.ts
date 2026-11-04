// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parsePolkadotAccount } from './polkadotAccount.js';

describe('parsePolkadotAccount', () => {
  it('As a page, I parse an SS58 address as a Polkadot account and keep its text', () => {
    // Given an SS58 address
    const raw = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

    // When the address is parsed
    const account = parsePolkadotAccount(raw);

    // Then the account keeps the text it was given
    expect(account).toBe(raw);
  });

  it.each(['0xabc', '5Grw O'])('As a page, I refuse %j as a Polkadot account and the error names it', raw => {
    // Given a string that is no SS58 address, from the table

    // When the string is parsed
    const run = () => parsePolkadotAccount(raw);

    // Then the parse throws and names the string
    expect(run).toThrow(raw);
  });

  it('As a page, I refuse an empty string as a Polkadot account', () => {
    // Given an empty string
    const raw = '';

    // When the string is parsed
    const run = () => parsePolkadotAccount(raw);

    // Then the parse throws with an empty name in its message
    expect(run).toThrow('Account  is not an SS58 address');
  });
});
