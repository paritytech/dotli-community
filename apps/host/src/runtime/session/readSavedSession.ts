// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The session the page's saved copy shows: the local wallet's when there is one, else the saved one with its cached
// account.

import type { Restored } from '../createWalletBoot.js';
import type { SessionRead, StoredSession } from './createCoreStorage.js';
import { getLocalSessionUiState } from './getLocalSessionUiState.js';
import { parseUiStateCache, type TruapiSessionUiState } from './parseUiStateCache.js';
import type { Presence } from './types.js';

/** What a read of the saved copy takes from the restore on load. */
export type LoadRestore = Pick<Restored, 'local' | 'session' | 'wallet' | 'presence'>;

/** Which read of the saved copy: the load's own, whose session the restore rule already read, or a read of the store. */
export type SavedSessionSource = 'load' | 'store';

type Params = {
  source: SavedSessionSource;
  store: Pick<StoredSession, 'readSession' | 'readUiCache'>;
  /** The restore on load, which a read of the copy always comes after. */
  restore: () => Promise<LoadRestore>;
};

/**
 * `flag` is the flag the load's restore read beside a copy that held nothing, and null for any other read.
 */
export type SavedSession = { session: TruapiSessionUiState | null; flag: Presence | null };

/** Reads the saved session to show, in one step. Rejects when the restore or a read of the store rejects. */
export async function readSavedSession({ source, store, restore }: Params): Promise<SavedSession> {
  switch (source) {
    case 'load': {
      // The restore rule clears the cached account only with the session it drops, which makes the cache unused, so
      // the read starts beside the rule.
      const cachedAccount = store.readUiCache();
      const restored = await restore();
      const raw = getBlob(restored.session);
      return {
        session: getSessionToShow(restored.local, raw, await cachedAccount),
        flag: hasHeldNothing(restored) ? restored.presence : null,
      };
    }
    case 'store': {
      // The restore first, since the session read must come after the rule.
      const { local } = await restore();
      const raw = getBlob(await store.readSession());
      // A sign-in elsewhere writes the cached account right after the session whose change started this read, so the
      // read waits for the session's.
      const cached = raw === null || local !== null ? null : await store.readUiCache();
      return { session: getSessionToShow(local, raw, cached), flag: null };
    }
  }
}

/** Whether the load's restore left the copy without a session or a wallet, as far as it could read. */
function hasHeldNothing({ session, wallet }: Pick<Restored, 'session' | 'wallet'>): boolean {
  return (
    session.status === 'ok' && session.blob === null && (wallet.status === 'none' || wallet.status === 'unreadable')
  );
}

function getBlob(read: SessionRead): string | null {
  return read.status === 'ok' ? read.blob : null;
}

/** The local wallet's session when there is one, else the saved one with its raw cached account. */
function getSessionToShow(
  local: LoadRestore['local'],
  raw: string | null,
  cached: string | null,
): TruapiSessionUiState | null {
  if (local !== null) {
    return getLocalSessionUiState(local.identity);
  }
  if (raw === null) {
    return null;
  }
  return (cached === null ? null : parseUiStateCache(cached)) ?? { connected: true };
}
