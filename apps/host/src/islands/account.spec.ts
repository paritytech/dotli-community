// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { createSyncStore } from '@dotli/shared';
import type { DotliAuthState } from '../runtime/session/auth-state.js';
import type { TruapiSessionUiState } from '../runtime/session/session-state.js';
import type { Account } from '../components/account/account.js';
import { useAccount } from './account.js';

const ALICE: TruapiSessionUiState = { connected: true, fullUsername: 'Alice Smith' };
const PAIRING: DotliAuthState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'app' };

/** The page's stores, as boot left them, and an account read from them under a fresh owner. */
function mount(auth: DotliAuthState, loggedIn = auth.tag === 'Connected') {
  const stores = {
    auth: createSyncStore<DotliAuthState>('account-test-auth', auth),
    loggedIn: createSyncStore('account-test-logged-in', loggedIn),
    walletMode: createSyncStore<{ mode: 'app' | 'local' }>('account-test-wallet-mode', { mode: 'app' }),
    signingOut: createSyncStore('account-test-signing-out', false),
    elsewhere: createSyncStore('account-test-elsewhere', false),
  };
  const { account, dispose } = createRoot(d => ({ account: useAccount(stores), dispose: d }));
  flush();
  return { stores, account, dispose };
}

function read(account: Account) {
  return {
    loggedIn: account.loggedIn(),
    session: account.session(),
    connected: account.connected(),
    restoring: account.restoring(),
    unreachable: account.unreachable(),
    signingOut: account.signingOut(),
    local: account.local(),
    elsewhere: account.elsewhere(),
  };
}

describe('useAccount', () => {
  it('As a visitor whose session is still being read, the account is restoring and signed out', () => {
    // When
    const { account, dispose } = mount({ tag: 'Restoring' });

    // Then
    expect(read(account)).toEqual({
      loggedIn: false,
      session: undefined,
      connected: false,
      restoring: true,
      unreachable: false,
      signingOut: false,
      local: false,
      elsewhere: false,
    });
    dispose();
  });

  it('As a signed-in user whose sign-out waits for the sign-out window, I look at the account and it says so until the sign-out ends', () => {
    // Given a signed-in account
    const { stores, account, dispose } = mount({ tag: 'Connected', session: ALICE });

    // When a sign-out starts waiting
    stores.signingOut.set(true);
    flush();

    // Then the account shows the wait and stays signed in
    expect(account.signingOut()).toBe(true);
    expect(account.loggedIn()).toBe(true);

    // When the wait ends
    stores.signingOut.set(false);
    flush();

    // Then the account no longer shows it
    expect(account.signingOut()).toBe(false);
    dispose();
  });

  it('As a signed-out user whose sign-in made elsewhere waits, I look at the account and it says so until the sign-in no longer waits', () => {
    // Given a signed-out account
    const { stores, account, dispose } = mount({ tag: 'Disconnected' });

    // When a sign-in made elsewhere starts waiting
    stores.elsewhere.set(true);
    flush();

    // Then the account offers it and stays signed out
    expect(account.elsewhere()).toBe(true);
    expect(account.loggedIn()).toBe(false);

    // When nothing waits any more
    stores.elsewhere.set(false);
    flush();

    // Then the account no longer offers it
    expect(account.elsewhere()).toBe(false);
    dispose();
  });

  it('As a user whose saved sign-in cannot be reached, the account says so', () => {
    // When
    const { account, dispose } = mount({ tag: 'Unreachable' });

    // Then
    expect(account.unreachable()).toBe(true);
    expect(account.restoring()).toBe(false);
    dispose();
  });

  it('As a signed-in user, a pairing that starts elsewhere keeps my session', () => {
    // Given
    const { stores, account, dispose } = mount({ tag: 'Connected', session: ALICE });

    // When
    stores.auth.set(PAIRING);
    flush();

    // Then
    expect(read(account)).toMatchObject({ loggedIn: true, session: ALICE, connected: false });
    dispose();
  });

  it('As a signed-in user, a disconnect signs me out', () => {
    // Given
    const { stores, account, dispose } = mount({ tag: 'Connected', session: ALICE });
    expect(read(account)).toMatchObject({ loggedIn: true, session: ALICE, connected: true });

    // When
    stores.auth.set({ tag: 'Disconnected' });
    stores.loggedIn.set(false);
    flush();

    // Then
    expect(read(account)).toMatchObject({ loggedIn: false, connected: false });
    dispose();
  });

  it('As a user signed in before this island mounted, during a pairing my session shows as a bare connection', () => {
    // When
    const { account, dispose } = mount(PAIRING, true);

    // Then
    expect(account.session()).toEqual({ connected: true });
    dispose();
  });

  it('As a local wallet user, the account says the keys are in this browser', () => {
    // Given
    const { stores, account, dispose } = mount({ tag: 'Connected', session: ALICE });

    // When
    stores.walletMode.set({ mode: 'local' });
    flush();

    // Then
    expect(account.local()).toBe(true);
    dispose();
  });
});
