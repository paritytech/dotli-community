// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { displayCall } from './site-call.js';

const ACCOUNT = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5';

describe('displayCall', () => {
  it('As a user, I review a decoded call and see each argument as text', () => {
    // Given a call with a bigint, bytes, a boolean, an absent value, an account and a nested struct
    const decoded = {
      type: 'Balances',
      value: {
        type: 'transfer_keep_alive',
        value: {
          dest: { type: 'Id', value: ACCOUNT },
          value: 12345678901234567890n,
          remark: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
          keep: true,
          tip: undefined,
          who: ACCOUNT,
        },
      },
    };

    // When the call is put into display form
    const call = displayCall(decoded);

    // Then the name joins pallet and call, and each top-level argument renders as text
    expect(call).toEqual({
      name: 'Balances.transfer_keep_alive',
      args: [
        { name: 'dest', value: `{\n  "type": "Id",\n  "value": "${ACCOUNT}"\n}` },
        { name: 'value', value: '12345678901234567890' },
        { name: 'remark', value: '0xdeadbeef' },
        { name: 'keep', value: 'true' },
        { name: 'tip', value: 'none' },
        { name: 'who', value: ACCOUNT },
      ],
    });
  });

  it('As a user, I review a nested value and see its inner bigints, bytes and absences as text', () => {
    // Given a call whose argument nests a list of structs
    const decoded = {
      type: 'Utility',
      value: {
        type: 'batch',
        value: {
          calls: [{ amount: 7n, data: new Uint8Array([1, 2]), memo: undefined, flag: false, count: 3 }],
        },
      },
    };

    // When the call is put into display form
    const call = displayCall(decoded);

    // Then the nested values follow the same rules inside the JSON text
    expect(call.args).toEqual([
      {
        name: 'calls',
        value:
          '[\n  {\n    "amount": "7",\n    "data": "0x0102",\n    "memo": "none",\n    "flag": false,\n    "count": 3\n  }\n]',
      },
    ]);
  });

  it('As a user, I review a call without arguments and see only its name', () => {
    // Given a call that takes no arguments
    const decoded = { type: 'System', value: { type: 'remark_none', value: undefined } };

    // When the call is put into display form
    const call = displayCall(decoded);

    // Then it has a name and no arguments
    expect(call).toEqual({ name: 'System.remark_none', args: [] });
  });
});
