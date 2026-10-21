// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so the naming rules are unit tested apart from the views that show them.

import type { AccountSession } from './account.js';

// A session can install without any username (the account has no dotNS record
// on this network), so initials only come from real names, never account hex.
export function sessionInitials(state: AccountSession): string | undefined {
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

export function sessionUsername(state: AccountSession): string | undefined {
  return state.primaryUsername ?? state.fullUsername ?? state.liteUsername;
}

export function shortenAccount(account: string | undefined): string | undefined {
  if (account === undefined || account.length < 12) {
    return undefined;
  }
  return `${account.slice(0, 8)}...${account.slice(-4)}`;
}

export function sessionDisplayName(state: AccountSession): string | undefined {
  return sessionUsername(state) ?? shortenAccount(state.identityAccountId ?? state.publicKey);
}
