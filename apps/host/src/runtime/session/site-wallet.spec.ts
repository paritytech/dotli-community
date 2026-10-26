// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readWalletOrFailed } from './site-wallet.js';

describe('readWalletOrFailed', () => {
  it('As a sign-out, I read a wallet read that rejects and get it as failed, with its error', async () => {
    // Given a wallet read the frame rejects
    const error = new Error('frame unreachable');

    // When the sign-out reads it
    const read = await readWalletOrFailed(() => Promise.reject(error));

    // Then the read answers as failed, carrying the rejection
    expect(read).toEqual({ status: 'failed', error });
  });

  it('As the restore rule, I read a wallet the frame answers and get that answer', async () => {
    // Given a wallet read the frame answers with no wallet
    const answer = { status: 'none' } as const;

    // When the restore rule reads it
    const read = await readWalletOrFailed(() => Promise.resolve(answer));

    // Then the read answers as the frame did
    expect(read).toEqual({ status: 'none' });
  });

  it('As a sign-out, I read a wallet read that throws at once and get it as failed, with its error', async () => {
    // Given a wallet read that throws before it returns a promise
    const error = new Error('frame missing');
    const read = (): Promise<never> => {
      throw error;
    };

    // When the sign-out reads it
    const result = await readWalletOrFailed(read);

    // Then the read answers as failed, carrying the throw
    expect(result).toEqual({ status: 'failed', error });
  });
});
