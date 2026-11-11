// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createRoot, flush } from 'solid-js';
import { atom } from 'nanostores';
import type { DotliAuthState } from '../runtime/session/types.js';
import type { TruapiSessionUiState } from '../runtime/session/parseUiStateCache.js';
import type { Account } from '../components/account/account.js';
import { useAccount } from './account.js';

const ALICE: TruapiSessionUiState = { connected: true, fullUsername: 'Alice Smith' };
const PAIRING: DotliAuthState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'app' };

/** The page's stores, as boot left them, and an account read from them under a fresh owner. */
function mount(auth: DotliAuthState, loggedIn = auth.tag === 'Connected') {
  const stores = {
    auth: atom<DotliAuthState>(auth),
    loggedIn: atom(loggedIn),
    local: atom(false),
    signingOut: atom(false),
    elsewhere: atom(false),
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
    knowledge: account.knowledge(),
    signingOut: account.signingOut(),
    local: account.local(),
    elsewhere: account.elsewhere(),
  };
}

describe('useAccount', () => {
  it('As a visitor whose session is still being read, the account says so and is signed out', () => {
    // When
    const { account, dispose } = mount({ tag: 'Restoring' });

    // Then
    expect(read(account)).toEqual({
      loggedIn: false,
      session: undefined,
      connected: false,
      knowledge: 'reading',
      signingOut: false,
      local: false,
      elsewhere: false,
    });
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

  it('As a user signed in before this island mounted, during a pairing my session shows as a bare connection', () => {
    // When
    const { account, dispose } = mount(PAIRING, true);

    // Then
    expect(account.session()).toEqual({ connected: true });
    dispose();
  });
});
