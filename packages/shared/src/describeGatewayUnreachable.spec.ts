// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { describeGatewayUnreachable } from './describeGatewayUnreachable.js';

describe('describeGatewayUnreachable', () => {
  it('As a visitor, I meet an unreachable provider and am told which one', () => {
    // When
    const copy = describeGatewayUnreachable('ipfs.example.io');

    // Then
    expect(copy).toBe("Your browser couldn't connect to the trusted provider ipfs.example.io.");
  });

  it('As a visitor, I meet an unreachable provider when none is configured and read a whole sentence', () => {
    // When
    const copy = describeGatewayUnreachable(undefined);

    // Then
    expect(copy).toBe("Your browser couldn't connect to the trusted provider.");
  });

  it('As a visitor, I meet an unreachable provider with an empty name and see no gap where it should be', () => {
    // When
    const copy = describeGatewayUnreachable('');

    // Then
    expect(copy).toBe("Your browser couldn't connect to the trusted provider.");
  });
});
