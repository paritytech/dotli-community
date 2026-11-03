// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SHARED_CORE_SESSION_KEY, type LocalWalletIdentity, type LocalWalletReadResult } from '@dotli/protocol';
import { waitForStatus } from '@dotli/shared';
import { atom, type ReadableAtom } from 'nanostores';
import type { DotliAuthState } from '../session/types.js';
import { createCoreStorage } from '../session/createCoreStorage.js';
import { createNonOwnerSignInFlag } from '../session/signInFlag.js';
import { createFakeSharedSessionStore } from '../session/createCoreStorage.fake.js';
import { createFakeSessionPresence } from '../session/createPagePresence.fake.js';
import { createSessionState } from '../session/createSessionState.js';
import { applySessionResult } from './applySessionResult.js';
import type { SessionResult } from './parseSessionResult.js';

/** What the page's copy of the main store holds. */
type Params = { blob?: string; uiState?: string; wallet?: LocalWalletReadResult };

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
function createPage(stored: Params = {}) {
  const shared = createFakeSharedSessionStore({ status: 'available' });
  if (stored.blob !== undefined) {
    shared.entries.set(SHARED_CORE_SESSION_KEY, stored.blob);
  }
  if (stored.uiState !== undefined) {
    shared.entries.set(UI_STATE_KEY, stored.uiState);
  }
  const storage = createCoreStorage({
    shared,
    flag: createNonOwnerSignInFlag({
      presence: createFakeSessionPresence({ state: 'present' }),
      readStoredSignIn: () => Promise.resolve('none'),
    }),
  });
  const auth = atom<DotliAuthState>({ tag: 'Disconnected' });
  const session = createSessionState({
    store: storage,
    async restore() {
      return { local: null, session: await storage.readSession(), wallet: { status: 'none' }, presence: 'present' };
    },
    auth: {
      store: auth,
      set: next => {
        auth.set(next);
      },
    },
    setElsewhere: () => undefined,
    isLocalWallet: () => false,
    isResumeOffered: () => true,
  });
  onTestFinished(session.start());
  const sessionChanges = vi.fn();
  onTestFinished(storage.subscribeStoredSession(sessionChanges));
  const saved: [Uint8Array, LocalWalletIdentity | null][] = [];
  const reload = vi.fn();
  const params = {
    installSession: (blob: string, uiState: string | null) => storage.installSession(blob, uiState),
    readWallet: () => Promise.resolve(stored.wallet ?? { status: 'none' as const }),
    saveWallet(entropy: Uint8Array, identity: LocalWalletIdentity | null) {
      saved.push([entropy, identity]);
      return Promise.resolve();
    },
    reload,
  };
  return { shared, auth, sessionChanges, saved, reload, params };
}

/** Waits until the page shows a sign-in, checking at each state it publishes. */
function waitUntilSignedIn(auth: ReadableAtom<DotliAuthState>): Promise<void> {
  return waitForStatus(auth, state => state.tag === 'Connected');
}

describe('applying a sign-in window result', () => {
  it('As a user signing in on a dot.li page, I get a paired session from the window and my core picks it up without a reload', async () => {
    // Given a page and a result with a paired session
    const page = createPage();
    const result: SessionResult = { session: { blob: BLOB, uiState: UI_STATE }, localWallet: null };

    // When the result is applied
    const applied = await applySessionResult(result, page.params);

    // Then the session is stored and announced with no reload
    expect(applied).toBe('applied');
    expect(page.shared.entries.get(SHARED_CORE_SESSION_KEY)).toBe(BLOB);
    expect(page.sessionChanges).toHaveBeenCalledTimes(1);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('As a Chrome user signing in on a dot.li page, I get a wallet my page already holds and the page skips saving it and keeps the account the window sent', async () => {
    // Given a copy that is the main store, already holding what the window sends
    const page = createPage({
      blob: BLOB,
      wallet: { status: 'ok', entropy: ENTROPY.slice(), identity: IDENTITY, version: Uint8Array.of(1) },
    });
    const result: SessionResult = {
      session: { blob: BLOB, uiState: UI_STATE },
      localWallet: { entropy: ENTROPY, identity: IDENTITY },
    };

    // When the result is applied
    const applied = await applySessionResult(result, page.params);

    // Then the wallet is not saved again, the account is cached, and the page reloads into local mode
    expect(page.shared.entries.get(UI_STATE_KEY)).toBe(UI_STATE);
    expect(page.saved).toEqual([]);
    expect(applied).toBe('reloading');
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('As a signed-out user on a page with no core, I receive a session and am shown signed in without a reload', async () => {
    // Given a signed-out page with no core and a result with a paired session
    const page = createPage();
    const result: SessionResult = { session: { blob: BLOB, uiState: UI_STATE }, localWallet: null };

    // When the result is applied and the page shows the change
    await applySessionResult(result, page.params);
    await waitUntilSignedIn(page.auth);

    // Then the page shows the account signed in with no reload
    expect(page.auth.get()).toEqual({ tag: 'Connected', session: ACCOUNT });
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('As a signed-out Chrome user on a page with no core, I receive a session my copy already holds and am shown signed in with my name', async () => {
    // Given a copy that is the main store, which the window already wrote, with no account cached yet
    const page = createPage({ blob: BLOB });
    const result: SessionResult = { session: { blob: BLOB, uiState: UI_STATE }, localWallet: null };

    // When the result is applied and the page shows the change
    await applySessionResult(result, page.params);
    await waitUntilSignedIn(page.auth);

    // Then the page and its cores are told, and the page shows the account the window sent
    expect(page.shared.entries.get(UI_STATE_KEY)).toBe(UI_STATE);
    expect(page.sessionChanges).toHaveBeenCalledTimes(1);
    expect(page.auth.get()).toEqual({ tag: 'Connected', session: ACCOUNT });
  });

  it('As a user signing in on a dot.li page, I get a wallet with its identity from the window and the page saves both and reloads', async () => {
    // Given a copy holding another wallet
    const other = Uint8Array.from({ length: 16 }, () => 7);
    const page = createPage({ wallet: { status: 'ok', entropy: other, identity: null, version: Uint8Array.of(1) } });
    const result: SessionResult = { session: null, localWallet: { entropy: ENTROPY, identity: IDENTITY } };

    // When the result is applied
    const applied = await applySessionResult(result, page.params);

    // Then the entropy and identity are saved together, and the page reloads into local mode
    expect(page.saved).toEqual([[ENTROPY, IDENTITY]]);
    expect(applied).toBe('reloading');
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('As a user signing in on a dot.li page, I receive a wallet the page cannot save and stay as I was while the failure reaches the caller', async () => {
    // Given a result carrying a session and a wallet, and a store that refuses the wallet
    const page = createPage();
    const failure = new Error('frame gone');
    const params = { ...page.params, saveWallet: () => Promise.reject(failure) };
    const result: SessionResult = {
      session: { blob: BLOB, uiState: UI_STATE },
      localWallet: { entropy: ENTROPY, identity: null },
    };

    // When the result is applied
    const applied = applySessionResult(result, params);

    // Then the session was not installed, no core heard a change and the page did not reload
    await expect(applied).rejects.toMatchObject({ cause: failure });
    expect(page.shared.writes).toEqual([]);
    expect(page.sessionChanges).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
  });
});
