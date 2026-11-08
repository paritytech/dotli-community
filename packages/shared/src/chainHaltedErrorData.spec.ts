// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { CHAIN_HALTED_ERROR_DATA, isChainHaltedRpcError } from './chainHaltedErrorData.js';

describe('isChainHaltedRpcError', () => {
  it.each([
    ['a JSON-RPC error', { code: -32603, message: 'Chain transport halted', data: CHAIN_HALTED_ERROR_DATA }],
    [
      'an error a client built from one',
      Object.assign(new Error('Chain transport halted'), {
        name: 'RpcError',
        code: -32603,
        data: CHAIN_HALTED_ERROR_DATA,
      }),
    ],
  ])('As a chain client, I check %s and it reads as a halt', (_name, error) => {
    // Given the row's answer, which carries the halt marker, from the table

    // When it is checked
    const halted = isChainHaltedRpcError(error);

    // Then it reads as a halt
    expect(halted).toBe(true);
  });

  it.each([
    ['an answer with other data', { code: -32603, message: 'Chain transport halted', data: 'other' }],
    ['an answer with the text and no marker', { code: -32603, message: 'Chain transport halted' }],
    ['no error', undefined],
    ['null', null],
    ['the marker as a string', CHAIN_HALTED_ERROR_DATA],
  ])('As a chain client, I check %s and it does not read as a halt', (_name, error) => {
    // Given the row's value, without the halt marker in its data, from the table

    // When it is checked
    const halted = isChainHaltedRpcError(error);

    // Then it does not read as a halt
    expect(halted).toBe(false);
  });
});
