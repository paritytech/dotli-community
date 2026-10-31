// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LocalWalletReadResult } from '@dotli/protocol';
import { describe, expect, it } from 'vitest';
import { bindReports } from '../../testing/bindReports.js';
import { readWalletOrFailed, recordPresenceWalletReadFailure, type WalletRead } from './siteWallet.js';

const REJECTION = new Error('frame unreachable');
const THROW = new Error('frame missing');

describe('readWalletOrFailed', () => {
  it.each<{ label: string; read: () => Promise<LocalWalletReadResult>; expected: WalletRead }>([
    {
      label: 'user signing out, I read a wallet read that rejects and get it as failed with its error',
      read: () => Promise.reject(REJECTION),
      expected: { status: 'failed', error: REJECTION },
    },
    {
      label: 'returning user, I read a wallet the frame answers and get that answer',
      read: () => Promise.resolve({ status: 'none' }),
      expected: { status: 'none' },
    },
    {
      label: 'user signing out, I read a wallet read that throws at once and get it as failed with its error',
      read: () => {
        throw THROW;
      },
      expected: { status: 'failed', error: THROW },
    },
  ])('As a $label', async ({ read, expected }) => {
    // Given a wallet read the frame rejects, answers with no wallet, or that throws before it returns a promise

    // When the caller reads it
    const result = await readWalletOrFailed(read);

    // Then the read answers as the frame did, or as failed carrying the rejection or the throw
    expect(result).toEqual(expected);
  });
});

describe('recordPresenceWalletReadFailure', () => {
  it('As an operator, I watch a wallet read made to check sign-in fail and it is counted as expected', () => {
    // Given a recorder of the page's counts and captures
    const { captures, counted } = bindReports();

    // When a wallet read made to check sign-in fails
    recordPresenceWalletReadFailure(new TypeError('frame unreachable'));

    // Then the failure is counted under the wallet read metric and nothing is captured as an exception
    expect(counted('session.wallet_read')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
    expect(captures.exception).not.toHaveBeenCalled();
  });
});
