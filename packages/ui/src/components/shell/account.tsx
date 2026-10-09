// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { TruapiSessionUiState } from '../../host-callbacks/SessionStore.js';
import { authStore, loggedInStore } from '../../state/auth.js';
import { useStore } from '../use-store.js';

export interface Account {
  /** True from `Connected` until `Disconnected` (loggedInStore). */
  loggedIn: Accessor<boolean>;
  /**
   * The last connected session, kept through the states in between.
   * A login whose session this island never saw shows as a bare `connected: true`.
   */
  session: Accessor<TruapiSessionUiState | undefined>;
  /** True while the auth state is `Connected` (authStore). */
  connected: Accessor<boolean>;
  /** True until boot has read the saved session (authStore). */
  restoring: Accessor<boolean>;
}

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
    restoring: () => auth().tag === 'Restoring',
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

export function sessionUsername(state: TruapiSessionUiState): string | undefined {
  return state.primaryUsername ?? state.fullUsername ?? state.liteUsername;
}

export function shortenAccount(account: string | undefined): string | undefined {
  if (account === undefined || account.length < 12) {
    return undefined;
  }
  return `${account.slice(0, 8)}...${account.slice(-4)}`;
}

export function sessionDisplayName(state: TruapiSessionUiState): string | undefined {
  return sessionUsername(state) ?? shortenAccount(state.identityAccountId ?? state.publicKey);
}

/** For an account without initials, or before sign-in. */
export function UserIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}
