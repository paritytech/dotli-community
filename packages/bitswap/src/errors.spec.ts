// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { errorCode, withCode } from './errors.js';

describe('bitswap error codes', () => {
  it('As the bitswap client, I read back the JSON-RPC code I put on an error, and none from anything else', () => {
    // Given
    const coded = withCode(new Error('peers lacked the block'), -32810);

    // When
    const codes = [errorCode(coded), errorCode(new Error('plain')), errorCode({ code: -32810 }), errorCode('x')];

    // Then
    expect(codes).toEqual([-32810, null, null, null]);
  });
});
