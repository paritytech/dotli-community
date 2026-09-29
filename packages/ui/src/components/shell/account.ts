// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the auth button's badge and the user popover show about the logged-in
// account; both live in the one auth island.

import { createMemo, type Accessor } from 'solid-js';
import type { TruapiSessionUiState } from '../../host-callbacks/SessionStore.js';
import { authStore, loggedInStore } from '../../state/auth.js';
import { useStore } from '../use-store.js';

export interface Account {
  /** True from `Connected` until `Disconnected` (loggedInStore). */
  loggedIn: Accessor<boolean>;
  /**
   * The last connected session. Only `Connected` carries one; the states in
   * between (a pairing elsewhere, say) keep it, as the topbar did. A login
   * whose session this island never saw (it came before the island mounted,
   * followed by another state) shows as a bare `connected: true`.
   */
  session: Accessor<TruapiSessionUiState | undefined>;
  /** True while the auth state is `Connected` (authStore). */
  connected: Accessor<boolean>;
}

/** Read the account from the auth stores. Call inside a component. */
export function useAccount(): Account {
  const auth = useStore(authStore);
  const loggedIn = useStore(loggedInStore);
  const last = createMemo<TruapiSessionUiState | undefined>(prev => {
    const state = auth();
    return state.tag === 'Connected' ? state.session : prev;
  });
  const connected = createMemo(() => auth().tag === 'Connected');
  return {
    loggedIn,
    session: () => last() ?? (loggedIn() ? { connected: true } : undefined),
    connected,
  };
}

// A session can install without any username (the account has no dotNS record
// on this network), so initials only come from real names, never account hex.
export function sessionInitials(state: TruapiSessionUiState): string | undefined {
  const fullName = state.fullUsername;
  if (fullName !== undefined && fullName.length > 0) {
    const [first, second] = fullName.split(' ').filter(part => part.length > 0);
    if (first !== undefined) {
      return second === undefined
        ? first.slice(0, 2).toUpperCase()
        : `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
    }
  }
  const liteName = state.liteUsername;
  if (liteName !== undefined && liteName.length > 0) {
    return liteName.slice(0, 2).toUpperCase();
  }
  return undefined;
}

/** The session's username, if it has one. */
export function sessionUsername(state: TruapiSessionUiState): string | undefined {
  return state.primaryUsername ?? state.fullUsername ?? state.liteUsername;
}

export function shortenAccount(account: string | undefined): string | undefined {
  if (account === undefined || account.length < 12) {
    return undefined;
  }
  return `${account.slice(0, 8)}...${account.slice(-4)}`;
}
