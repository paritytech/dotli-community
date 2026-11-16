// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The account a paired session shows before any core reports it, from its cached UI state. It imports nothing of the
// page's session layer, so a page without one can read it.

import { createReporter } from '@dotli/metrics';
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

const OPTIONAL_STRING_FIELDS: readonly Exclude<keyof TruapiSessionUiState, 'connected'>[] = [
  'publicKey',
  'identityAccountId',
  'liteUsername',
  'fullUsername',
  'primaryUsername',
];

/**
 * The cached account, null when there is no cache or it is signed out. The cache can be stale from another code version
 * or corrupt, so a malformed blob degrades to null too.
 */
export function parseUiStateCache(raw: string | null): TruapiSessionUiState | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuseCache('json');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return refuseCache('shape');
  }
  if (Reflect.get(parsed, 'connected') !== true) {
    return null;
  }
  const uiState: TruapiSessionUiState = { connected: true };
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value: unknown = Reflect.get(parsed, field);
    if (!isOptionalString(value)) {
      return refuseCache('shape');
    }
    if (value !== undefined) {
      uiState[field] = value;
    }
  }
  return uiState;
}

/** Records a cache that does not parse and returns null. A stale cache, which the next session report rewrites. */
function refuseCache(reason: 'json' | 'shape'): null {
  report.log.event('Session UI cache unreadable', { reason });
  sharedSessionUiCacheMetric.count({ outcome: 'invalid', reason });
  return null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
