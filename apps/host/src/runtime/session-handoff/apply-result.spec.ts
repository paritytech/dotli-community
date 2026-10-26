// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SHARED_CORE_SESSION_KEY, type LocalWalletIdentity, type LocalWalletReadResult } from '@dotli/protocol';
import { createSyncStore, untilStatus, type ReadableStore } from '@dotli/shared';
import type { DotliAuthState } from '../session/auth-state.js';
import { createCoreStorage } from '../session/core-storage.js';
import { pageSignInFlag } from '../session/sign-in-flag.js';
import { createFakeSharedSessionStore } from '../session/core-storage.fake.js';
import { createFakeSessionPresence } from '../session/presence.fake.js';
import { createSessionState } from '../session/session-state.js';
import { applySessionResult } from './apply-result.js';
import type { SessionResult } from './messages.js';

const BLOB = '0x0a0b';
const ACCOUNT = { connected: true, liteUsername: 'alice.dot' };
const UI_STATE = JSON.stringify(ACCOUNT);
const UI_STATE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;
const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const IDENTITY: LocalWalletIdentity = { identityAccountId: '5Alice', liteUsername: 'alice.dot' };

/**
 * A page whose copy holds `stored`, with the session written through its real core storage over a fake store, and
 * session state started over it with no core booted, as on the landing page.
 */
function page(stored: { blob?: string; uiState?: string; wallet?: LocalWalletReadResult } = {}) {
  const shared = createFakeSharedSessionStore('available');
  if (stored.blob !== undefined) {
    shared.entries.set(SHARED_CORE_SESSION_KEY, stored.blob);
  }
  if (stored.uiState !== undefined) {
    shared.entries.set(UI_STATE_KEY, stored.uiState);
  }
  const storage = createCoreStorage({
    shared,
    flag: pageSignInFlag({
      presence: createFakeSessionPresence('present'),
      storedSignIn: () => Promise.resolve('none'),
    }),
  });
  const auth = createSyncStore<DotliAuthState>('auth', { tag: 'Disconnected' }, { equals: () => false });
  const session = createSessionState({
    store: storage,
    restore: async () => ({
      local: null,
      session: await storage.readSession(),
      wallet: { status: 'none' },
      presence: 'present',
    }),
    auth,
    elsewhere: () => undefined,
    isLocalWallet: () => false,
    offersResume: () => true,
  });
  onTestFinished(session.start());
  const sessionChanges = vi.fn();
  onTestFinished(storage.onStoredSessionChanged(sessionChanges));
  const saved: [Uint8Array, LocalWalletIdentity | null][] = [];
  const reload = vi.fn();
  const deps = {
    installSession: (blob: string, uiState: string | null) => storage.installSession(blob, uiState),
    readWallet: () => Promise.resolve(stored.wallet ?? { status: 'none' as const }),
    saveWallet: (entropy: Uint8Array, identity: LocalWalletIdentity | null) => {
      saved.push([entropy, identity]);
      return Promise.resolve();
    },
    reload,
  };
  return { shared, auth, sessionChanges, saved, reload, deps };
}

/** Waits until the page shows a sign-in, checking at each state it publishes. */
function untilSignedIn(auth: ReadableStore<DotliAuthState>): Promise<void> {
  return untilStatus(
    {
      get: auth.get,
      subscribe: listener =>
        auth.subscribe(() => {
          listener(auth.get());
        }),
    },
    state => state.tag === 'Connected',
  );
}

describe('applying a sign-in window result', () => {
  it('As a page, I install a received session and my core picks it up without a reload', async () => {
    // Given a page and a result with a paired session
    const tab = page();
    const result: SessionResult = { session: { blob: BLOB, uiState: UI_STATE }, localWallet: null };

    // When the result is applied
    const applied = await applySessionResult(result, tab.deps);

    // Then the session is stored and announced with no reload
    expect(applied).toBe('applied');
    expect(tab.shared.entries.get(SHARED_CORE_SESSION_KEY)).toBe(BLOB);
    expect(tab.sessionChanges).toHaveBeenCalledTimes(1);
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it('As a Chrome page, I skip saving a wallet I already hold and keep the account the window sent', async () => {
    // Given a copy that is the main store, already holding what the window sends
    const tab = page({
      blob: BLOB,
      wallet: { status: 'ok', entropy: ENTROPY.slice(), identity: IDENTITY, version: Uint8Array.of(1) },
    });
    const result: SessionResult = {
      session: { blob: BLOB, uiState: UI_STATE },
      localWallet: { entropy: ENTROPY, identity: IDENTITY },
    };

    // When the result is applied
    const applied = await applySessionResult(result, tab.deps);

    // Then the wallet is not saved again, the account is cached, and the page reloads into local mode
    expect(tab.shared.entries.get(UI_STATE_KEY)).toBe(UI_STATE);
    expect(tab.saved).toEqual([]);
    expect(applied).toBe('reloading');
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it('As a signed-out user on a page with no core, I receive a session and am shown signed in without a reload', async () => {
    // Given a signed-out page with no core and a result with a paired session
    const tab = page();
    const result: SessionResult = { session: { blob: BLOB, uiState: UI_STATE }, localWallet: null };

    // When the result is applied
    await applySessionResult(result, tab.deps);

    // Then the page shows the account signed in with no reload
    await untilSignedIn(tab.auth);
    expect(tab.auth.get()).toEqual({ tag: 'Connected', session: ACCOUNT });
    expect(tab.reload).not.toHaveBeenCalled();
  });

  it('As a signed-out Chrome user on a page with no core, I receive a session my copy already holds and am shown signed in with my name', async () => {
    // Given a copy that is the main store, which the window already wrote, with no account cached yet
    const tab = page({ blob: BLOB });
    const result: SessionResult = { session: { blob: BLOB, uiState: UI_STATE }, localWallet: null };

    // When the result is applied
    await applySessionResult(result, tab.deps);

    // Then the page and its cores are told, and the page shows the account the window sent
    expect(tab.shared.entries.get(UI_STATE_KEY)).toBe(UI_STATE);
    expect(tab.sessionChanges).toHaveBeenCalledTimes(1);
    await untilSignedIn(tab.auth);
    expect(tab.auth.get()).toEqual({ tag: 'Connected', session: ACCOUNT });
  });

  it('As a page, I save a received wallet with its identity', async () => {
    // Given a copy holding another wallet
    const other = Uint8Array.from({ length: 16 }, () => 7);
    const tab = page({ wallet: { status: 'ok', entropy: other, identity: null, version: Uint8Array.of(1) } });
    const result: SessionResult = { session: null, localWallet: { entropy: ENTROPY, identity: IDENTITY } };

    // When the result is applied
    const applied = await applySessionResult(result, tab.deps);

    // Then the entropy and identity are saved together, and the page reloads into local mode
    expect(tab.saved).toEqual([[ENTROPY, IDENTITY]]);
    expect(applied).toBe('reloading');
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it('As a page, I receive a wallet I cannot save and stay as I was while the failure reaches my caller', async () => {
    // Given a result carrying a session and a wallet, and a store that refuses the wallet
    const tab = page();
    const failure = new Error('frame gone');
    const deps = { ...tab.deps, saveWallet: () => Promise.reject(failure) };
    const result: SessionResult = {
      session: { blob: BLOB, uiState: UI_STATE },
      localWallet: { entropy: ENTROPY, identity: null },
    };

    // When the result is applied
    const applied = applySessionResult(result, deps);

    // Then the session was not installed, no core heard a change and the page did not reload
    await expect(applied).rejects.toMatchObject({ cause: failure });
    expect(tab.shared.writes).toEqual([]);
    expect(tab.sessionChanges).not.toHaveBeenCalled();
    expect(tab.reload).not.toHaveBeenCalled();
  });
});
