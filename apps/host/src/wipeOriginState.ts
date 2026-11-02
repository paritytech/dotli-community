// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The origin wipe a full settings reset runs. It keeps what the other layers on this origin own.

import { reportExpected, spans as S } from '@dotli/metrics';
import {
  type ListableStorage,
  OriginWipeError,
  pageLocalStorage,
  pageSessionStorage,
  wipeOriginStores,
  type OriginStores,
  type OriginWipePart,
  type SafeStorage,
} from '@dotli/shared';
import { SHARED_AUTH_KEY_PREFIX, SHARED_MODE_KEY_PREFIX } from '@dotli/protocol';
import { SMOLDOT_DB_NAME } from '@dotli/chains';
import { SITE_GRANTS_DB_NAME, WALLET_DB_NAME } from '@dotli/storage';
import { THEME_KEY } from './themeKey.js';

export type WipeFailure = OriginWipePart;

/** What a wipe empties: the origin's browser stores and both web storages. */
export type WipeParts = {
  stores: OriginStores;
  local: ListableStorage;
  session: SafeStorage;
};

/** The databases other layers own on the origin the landing page shares with them, which a wipe there keeps. */
const OTHER_LAYERS_DATABASES: readonly string[] = [WALLET_DB_NAME, SITE_GRANTS_DB_NAME, SMOLDOT_DB_NAME];

/** Survive a reset, since losing the theme would be a visible change nobody requested. */
const PRESERVED_KEYS: readonly string[] = [THEME_KEY];

/** The frame at `/p/` shares this origin, so its session and settings are not the landing page's to wipe. */
const FRAME_KEY_PREFIXES: readonly string[] = [SHARED_AUTH_KEY_PREFIX, SHARED_MODE_KEY_PREFIX];

/**
 * Empties the origin and resolves the parts that failed, after reporting each, so the caller counts them without a
 * second report. A browser that cannot list its databases fails the `indexeddb` part.
 */
export async function wipeOriginState(parts: WipeParts = getBrowserWipeParts()): Promise<readonly WipeFailure[]> {
  let failed: WipeFailure[] = [];
  try {
    await wipeOriginStores(parts.stores, { keepDatabases: OTHER_LAYERS_DATABASES });
  } catch (error: unknown) {
    if (!(error instanceof OriginWipeError)) {
      throw error;
    }
    failed = [...error.failures.keys()];
    for (const [reason, cause] of error.failures) {
      reportExpected(cause, {
        flow: 'storage',
        step: `origin_wipe_${reason}`,
        metric: S.ORIGIN_WIPE,
        reason,
        message: `[dot.li settings] ${reason} wipe failed:`,
      });
    }
  }
  parts.session.clear();
  // Removes key by key, never clearing and restoring, so a write the frame makes meanwhile is not undone.
  for (const key of parts.local.keys()) {
    if (!PRESERVED_KEYS.includes(key) && !FRAME_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) {
      parts.local.removeItem(key);
    }
  }
  return failed;
}

/** Read on use, since the page loads this module before it knows it will wipe. */
function getBrowserWipeParts(): WipeParts {
  return {
    stores: {
      indexedDB: typeof indexedDB === 'undefined' ? null : indexedDB,
      caches: typeof caches === 'undefined' ? null : caches,
      serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
    },
    local: pageLocalStorage,
    session: pageSessionStorage,
  };
}
