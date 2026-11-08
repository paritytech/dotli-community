// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo } from 'solid-js';
import type { ReadableAtom } from 'nanostores';
import type { DotliAuthState } from '../runtime/session/types.js';
import type { TruapiSessionUiState } from '../runtime/session/parseUiStateCache.js';
import { useStore } from '@dotli/stores-solid';
import { authViews } from '../runtime/session/authViews.js';
import type { Account } from '../components/account/account.js';

export type AccountStores = {
  auth: ReadableAtom<DotliAuthState>;
  loggedIn: ReadableAtom<boolean>;
  /** Whether the page runs on a local wallet. */
  local: ReadableAtom<boolean>;
  signingOut: ReadableAtom<boolean>;
  elsewhere: ReadableAtom<boolean>;
};

/** The account as the views read it, for an island's own lifetime. */
export function useAccount(stores: AccountStores): Account {
  const auth = useStore(stores.auth);
  const loggedIn = useStore(stores.loggedIn);
  const local = useStore(stores.local);
  const signingOut = useStore(stores.signingOut);
  const elsewhere = useStore(stores.elsewhere);
  const last = createMemo<TruapiSessionUiState | undefined>(prev => authViews.getSignedInSession(auth()) ?? prev);
  const connected = createMemo(() => authViews.getSignedInSession(auth()) !== null);
  const knowledge = createMemo(() => authViews.getSessionKnowledge(auth()));
  return {
    loggedIn,
    session: () => last() ?? (loggedIn() ? { connected: true } : undefined),
    connected,
    knowledge,
    signingOut,
    local,
    elsewhere,
  };
}
