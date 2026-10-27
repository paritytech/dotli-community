// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createChainHaltedError } from './createChainHaltedError.js';
import { createJsonRpcError } from './createJsonRpcError.js';

describe('createJsonRpcError', () => {
  it('As a chain transport, I answer a failed request with an internal error, or with the halt error as it is', () => {
    // When
    const plain = createJsonRpcError(7, 'Unknown subscription/token');
    const halted = createJsonRpcError('a1', createChainHaltedError());

    // Then
    expect(plain).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32603, message: 'Unknown subscription/token' },
    });
    expect(halted).toEqual({ jsonrpc: '2.0', id: 'a1', error: createChainHaltedError() });
  });
});
