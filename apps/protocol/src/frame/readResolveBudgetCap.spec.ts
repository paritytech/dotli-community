// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readResolveBudgetCap } from './readResolveBudgetCap.js';

describe('readResolveBudgetCap', () => {
  it.each([
    ['a positive whole number of milliseconds', '1000', 1000],
    ['no key', null, undefined],
    ['a value that is not a number', 'soon', undefined],
    ['zero', '0', undefined],
  ])('As a tester, I tune my session with %s and get a resolve budget cap of %j', (_case, raw, cap) => {
    // Given
    const session = { getItem: (key: string) => (key === 'dotli:resolve-budget-ms' ? raw : null) };

    // When
    const read = readResolveBudgetCap(session);

    // Then
    expect(read).toBe(cap);
  });

  it('As a tester whose browser blocks frame storage, I read my session and get no resolve budget cap', () => {
    // Given a session the browser blocked
    const blockedSession = null;

    // When
    const cap = readResolveBudgetCap(blockedSession);

    // Then
    expect(cap).toBeUndefined();
  });
});
