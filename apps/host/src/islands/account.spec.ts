// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { createSyncStore } from '@dotli/shared';
import type { DotliAuthState, TruapiSessionUiState } from '@dotli/host-runtime';
import type { Account } from '../components/account/account.js';
import { useAccount } from './account.js';

const ALICE: TruapiSessionUiState = { connected: true, fullUsername: 'Alice Smith' };
const PAIRING: DotliAuthState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'app' };

/** The page's three stores, as boot left them, and an account read from them under a fresh owner. */
function mount(auth: DotliAuthState, loggedIn = auth.tag === 'Connected') {
  const stores = {
    auth: createSyncStore<DotliAuthState>('account-test-auth', auth),
    loggedIn: createSyncStore('account-test-logged-in', loggedIn),
    walletMode: createSyncStore<{ mode: 'app' | 'local' }>('account-test-wallet-mode', { mode: 'app' }),
  };
  const subscribe = vi.spyOn(stores.auth, 'subscribe');
  const { account, dispose } = createRoot(d => ({ account: useAccount(stores), dispose: d }));
  flush();
  return { stores, account, dispose, subscribe };
}

function read(account: Account) {
  return {
    loggedIn: account.loggedIn(),
    session: account.session(),
    connected: account.connected(),
    restoring: account.restoring(),
    unreachable: account.unreachable(),
    local: account.local(),
  };
}

describe('useAccount', () => {
  it('As the account button, I follow the auth store through one subscription', () => {
    // When
    const { subscribe, dispose } = mount({ tag: 'Restoring' });

    // Then
    expect(subscribe).toHaveBeenCalledTimes(1);
    dispose();
  });

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
      local: false,
    });
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

  it('As a signed-in user, a pairing that starts elsewhere keeps my session, and a disconnect signs me out', () => {
    // Given
    const { stores, account, dispose } = mount({ tag: 'Connected', session: ALICE });
    expect(read(account)).toMatchObject({ loggedIn: true, session: ALICE, connected: true });

    // When
    stores.auth.set(PAIRING);
    flush();

    // Then
    expect(read(account)).toMatchObject({ loggedIn: true, session: ALICE, connected: false });

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
