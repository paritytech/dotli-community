// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LocalWalletIdentity } from '@dotli/protocol';
import type { TruapiSessionUiState } from './parseUiStateCache.js';

/**
 * The UI state of a local wallet session, from its stored identity. Before the first network read the record has no
 * identity, so the state is signed in without a name.
 */
export function getLocalSessionUiState(identity: LocalWalletIdentity | null): TruapiSessionUiState {
  if (identity === null) {
    return { connected: true };
  }
  return {
    connected: true,
    identityAccountId: identity.identityAccountId,
    ...(identity.liteUsername !== null
      ? { liteUsername: identity.liteUsername, primaryUsername: identity.liteUsername }
      : {}),
  };
}
