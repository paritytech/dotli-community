// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

import { removeContractParams } from './contractParams.js';

describe('removeContractParams', () => {
  it("As the host, I strip the contract params from a product's query and its own parts keep their bytes", () => {
    // Given a product query that mixes its own parts with contract params.
    const search = '?q=a%20b&cid=x&path=/x&flag&v=3';

    // When the host strips the contract params.
    const query = removeContractParams(search);

    // Then only the product's parts are left, as they were typed and in order.
    expect(query).toBe('q=a%20b&path=/x&flag');
  });

  it("As the host, I strip a contract param a visitor's link escaped, as the sandbox would read it", () => {
    // Given a link whose contract key is percent-escaped.
    const search = '?%63id=forged&a=b';

    // When the host strips the contract params.
    const query = removeContractParams(search);

    // Then the escaped key is stripped like its plain name.
    expect(query).toBe('a=b');
  });

  it('As the host, I read a query with a malformed escape and keep that part as written', () => {
    // Given a query with a malformed escape beside a contract param.
    const search = '?%zz=1&cid=x';

    // When the host strips the contract params.
    const query = removeContractParams(search);

    // Then the malformed part stays as written.
    expect(query).toBe('%zz=1');
  });
});
