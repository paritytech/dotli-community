// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseH160Address } from './h160Address.js';

describe('parseH160Address', () => {
  it('As a page, I parse 20 bytes of 0x hex as an Asset Hub address and keep its text', () => {
    // Given an address in mixed case
    const raw = `0x${'aB'.repeat(20)}`;

    // When the address is parsed
    const address = parseH160Address(raw);

    // Then the address keeps the text it was given
    expect(address).toBe(raw);
  });

  it.each(['5Owner', `0x${'ab'.repeat(19)}`, `0x${'zz'.repeat(20)}`, 'ab'.repeat(21)])(
    'As a page, I refuse %j as an Asset Hub address and the error names it',
    raw => {
      // Given a string that is no 20-byte hex address, from the table

      // When the string is parsed
      const run = () => parseH160Address(raw);

      // Then the parse throws and names the string
      expect(run).toThrow(raw);
    },
  );
});
