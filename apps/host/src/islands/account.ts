// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo } from 'solid-js';
import type { ReadableStore } from '@dotli/shared';
import type { DotliAuthState } from '../runtime/session/auth-state.js';
import type { TruapiSessionUiState } from '../runtime/session/session-state.js';
import { useStore } from '@dotli/ui';
import type { Account } from '../components/account/account.js';

export type AccountStores = {
  auth: ReadableStore<DotliAuthState>;
  loggedIn: ReadableStore<boolean>;
  walletMode: ReadableStore<{ mode: 'app' | 'local' }>;
  signingOut: ReadableStore<boolean>;
  elsewhere: ReadableStore<boolean>;
};

/** The account as the views read it, for an island's own lifetime. */
export function useAccount(stores: AccountStores): Account {
  const auth = useStore(stores.auth);
  const loggedIn = useStore(stores.loggedIn);
  const local = useStore(stores.walletMode, state => state.mode === 'local');
  const signingOut = useStore(stores.signingOut);
  const elsewhere = useStore(stores.elsewhere);
  const last = createMemo<TruapiSessionUiState | undefined>(prev => {
    const state = auth();
    return state.tag === 'Connected' ? state.session : prev;
  });
  const connected = createMemo(() => auth().tag === 'Connected');
  return {
    loggedIn,
    session: () => last() ?? (loggedIn() ? { connected: true } : undefined),
    connected,
    restoring: () => auth().tag === 'Restoring',
    unreachable: () => auth().tag === 'Unreachable',
    signingOut,
    local,
    elsewhere,
  };
}
