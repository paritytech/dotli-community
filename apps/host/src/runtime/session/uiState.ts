// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The account a sign-in shows before any core reports it: a paired session's cached UI state, or a local wallet's
// stored identity. Apart from session state, so the sign-in window reads them without the page's session layer.

import type { LocalWalletIdentity } from '@dotli/protocol';
import { m, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';

export type TruapiSessionUiState = {
  connected: boolean;
  publicKey?: string;
  identityAccountId?: string;
  liteUsername?: string;
  fullUsername?: string;
  primaryUsername?: string;
};

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** The cache can be stale from another code version or corrupt, so a malformed blob degrades to null. */
export function parseUiStateCache(raw: string): TruapiSessionUiState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A stale cache, which the next session report rewrites, rather than a failure.
    log.event('Session UI cache unreadable', { flow: 'storage', error: errorName(err) ?? 'unknown' });
    m.count(S.SHARED_SESSION_UI_CACHE, { outcome: 'invalid', reason: 'json' });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const state = parsed as Record<string, unknown>;
  if (
    state['connected'] !== true ||
    !isOptionalString(state['publicKey']) ||
    !isOptionalString(state['identityAccountId']) ||
    !isOptionalString(state['liteUsername']) ||
    !isOptionalString(state['fullUsername']) ||
    !isOptionalString(state['primaryUsername'])
  ) {
    return null;
  }
  return {
    connected: true,
    ...(state['publicKey'] !== undefined ? { publicKey: state['publicKey'] } : {}),
    ...(state['identityAccountId'] !== undefined ? { identityAccountId: state['identityAccountId'] } : {}),
    ...(state['liteUsername'] !== undefined ? { liteUsername: state['liteUsername'] } : {}),
    ...(state['fullUsername'] !== undefined ? { fullUsername: state['fullUsername'] } : {}),
    ...(state['primaryUsername'] !== undefined ? { primaryUsername: state['primaryUsername'] } : {}),
  };
}

/**
 * The UI state of a local wallet session. Before the first network read the record has no identity, so the badge shows
 * signed in without a name.
 */
export function localSessionUiState(identity: LocalWalletIdentity | null): TruapiSessionUiState {
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
