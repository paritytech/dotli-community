// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The account a paired session shows before any core reports it, from its cached UI state. It imports nothing of the
// page's session layer, so a page without one can read it.

import { createReporter } from '@dotli/metrics';
import { getErrorName } from '@dotli/shared';
import { sharedSessionUiCacheMetric } from './sharedSessionUiCacheMetric.js';

const report = createReporter({ flow: 'storage' });

export type TruapiSessionUiState = {
  connected: boolean;
  publicKey?: string;
  identityAccountId?: string;
  liteUsername?: string;
  fullUsername?: string;
  primaryUsername?: string;
};

/** The cache can be stale from another code version or corrupt, so a malformed blob degrades to null. Never throws. */
export function parseUiStateCache(raw: string): TruapiSessionUiState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A stale cache, which the next session report rewrites, rather than a failure.
    report.log.event('Session UI cache unreadable', { error: getErrorName(error) ?? 'unknown' });
    sharedSessionUiCacheMetric.count({ outcome: 'invalid', reason: 'json' });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  // An object read field by field, and every field is checked below before it is used.
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

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
