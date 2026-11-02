// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { AuthState } from '@parity/truapi-host';
import { createRecordingCallbacks } from '../testing/createRecordingCallbacks.js';
import { watchIdentityAccount } from './watchIdentityAccount.js';

const PUBLIC_KEY = `0x${'01'.repeat(32)}` as const;
const IDENTITY_ACCOUNT = `0x${'11'.repeat(32)}` as const;

describe('local wallet core identity', () => {
  it('As a local wallet user, I connect and my core reports my identity account while session state still hears every state', async () => {
    // Given callbacks watched for the identity account
    const states: AuthState[] = [];
    const watched = watchIdentityAccount(createRecordingCallbacks(states));
    const connected: AuthState = {
      tag: 'Connected',
      value: { publicKey: PUBLIC_KEY, identityAccountId: IDENTITY_ACCOUNT },
    };

    // When the core reports authenticating, then connected
    watched.callbacks.auth.authStateChanged({ tag: 'Authenticating' });
    watched.callbacks.auth.authStateChanged(connected);

    // Then the identity account is caught and every state passes on
    await expect(watched.identityAccountId).resolves.toBe(IDENTITY_ACCOUNT);
    expect(states).toEqual([{ tag: 'Authenticating' }, connected]);
  });
});
