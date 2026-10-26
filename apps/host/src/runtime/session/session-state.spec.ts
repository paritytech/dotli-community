// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { SHARED_CORE_SESSION_KEY } from '@dotli/protocol';
import type { AuthState, SessionUiInfo } from '@parity/truapi-host';
import { createAuthStateChanged, type DotliAuthState } from './auth-state.js';
import { createCoreStorage, type HostCoreStorage } from './core-storage.js';
import { pageSignInFlag } from './sign-in-flag.js';
import { createSessionState, type PairingPresentation, type SessionState } from './session-state.js';
import { createSyncStore, type SyncStore } from '@dotli/shared';
import { createChanges } from '../../testing/changes.js';
import type { LocalWalletBoot } from '../wallet-boot.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createFakeSharedSessionStore, type FakeSharedSessionStore } from './core-storage.fake.js';
import type { Presence } from './presence.js';
import { createFakeSessionPresence, type FakeSessionPresence } from './presence.fake.js';
import { createPagePresence } from './presence.js';
import { offersResume, sharesFlag, type PageRole } from '../page-role.js';

const SESSION_KEY = SHARED_CORE_SESSION_KEY;
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;
const AUTH_SESSION_KEY = { tag: 'AuthSession' as const };
const UNREACHABLE = new Error('protocol iframe never listened');

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// The core reports these as `Bytes32` hex, so the UI state carries them through unencoded.
const SESSION_PUBLIC_KEY = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' as const;
const SESSION_IDENTITY_ACCOUNT_ID = '0xa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf' as const;

function connectedSessionUiInfo(): SessionUiInfo {
  return {
    publicKey: SESSION_PUBLIC_KEY,
    identityAccountId: SESSION_IDENTITY_ACCOUNT_ID,
    liteUsername: 'pgherveou.04',
  };
}

const CONNECTED_DETAIL = {
  connected: true,
  publicKey: SESSION_PUBLIC_KEY,
  identityAccountId: SESSION_IDENTITY_ACCOUNT_ID,
  liteUsername: 'pgherveou.04',
  primaryUsername: 'pgherveou.04',
};

const PAIRING: PairingPresentation = { label: 'Polkadot Web' };

let shared: FakeSharedSessionStore;
let coreStorage: HostCoreStorage;
let wallet: LocalWalletBoot | null;
let localWallet: boolean;
let auth: SyncStore<DotliAuthState>;
let session: SessionState;
let presence: FakeSessionPresence;
/** The flag as the load's restore read it. */
let loadFlag: Presence;
/** Whether the page last said a sign-in made elsewhere waits for it. */
let elsewhere: boolean;
/** What the page is to sign-in. */
let role: PageRole;

/** Every auth state the store publishes from now on. */
function recordAuthStates(): unknown[] {
  const states: unknown[] = [];
  auth.subscribe(() => {
    states.push(auth.get());
  });
  return states;
}

/** Waits on the auth store, checking again at each state it publishes rather than on a timer. */
const published = {
  until: (met: () => boolean): Promise<void> => {
    const changes = createChanges();
    const stop = auth.subscribe(changes.notify);
    return changes.until(met).finally(stop);
  },
};

/** The core reporting a state, as its auth presenter does. */
function coreReports(state: AuthState, pairing: PairingPresentation = PAIRING): void {
  session.reportCoreAuthState(state, pairing);
}

describe('session state', () => {
  beforeEach(() => {
    shared = createFakeSharedSessionStore();
    presence = createFakeSessionPresence('present');
    coreStorage = createCoreStorage({
      shared,
      flag: pageSignInFlag({ presence, storedSignIn: () => Promise.resolve('none') }),
    });
    wallet = null;
    localWallet = false;
    loadFlag = 'present';
    elsewhere = false;
    role = 'page';
    // Each test is a fresh page, whose auth state is Restoring until the saved session is read.
    auth = createSyncStore<DotliAuthState>('auth', { tag: 'Restoring' }, { equals: () => false });
    reloadPage();
  });

  /** The page loading again over the same store: its auth state is Restoring and its restore reads once more. */
  function reloadPage(): void {
    auth.reset();
    // Reads the session once per load and keeps the answer.
    let loadRead: ReturnType<HostCoreStorage['readSession']> | undefined;
    session = createSessionState({
      store: coreStorage,
      restore: async () => {
        loadRead ??= coreStorage.readSession();
        return {
          local: wallet,
          session: await loadRead,
          wallet: wallet ?? { status: 'none' },
          presence: loadFlag,
        };
      },
      auth,
      elsewhere: next => {
        elsewhere = next;
      },
      isLocalWallet: () => localWallet,
      offersResume: () => offersResume(role),
    });
  }

  it('As a returning user whose saved session could not be read, the disconnect that follows shows as unreachable and keeps my cached account', async () => {
    // Given
    const storage = coreStorage.adapters();
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    shared.readError = UNREACHABLE;
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When
    coreReports({ tag: 'Disconnected' });
    await flushMicrotasks();

    // Then
    expect(auth.get()).toEqual({ tag: 'Unreachable' });
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(JSON.stringify(CONNECTED_DETAIL));
  });

  it('As a returning user whose store answers again, the next disconnect is a plain logout', async () => {
    // Given
    const storage = coreStorage.adapters();
    shared.readError = UNREACHABLE;
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    shared.readError = null;
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When
    coreReports({ tag: 'Disconnected' });

    // Then
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a returning user, the host reads my saved session as soon as session state starts, without waking running cores', async () => {
    // Given
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    const coreNotified = vi.fn();
    const unsubscribe = coreStorage.onStoredSessionChanged(coreNotified);

    // When
    const stop = session.start();

    // Then
    await published.until(() => auth.get().tag === 'Connected');
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    expect(coreNotified).not.toHaveBeenCalled();
    stop();
    unsubscribe();
  });

  it('As a page loading, I show the session the restore read without reading it again', async () => {
    // Given a stored session and its account
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));

    // When the session state starts
    const stop = session.start();
    await published.until(() => auth.get().tag === 'Connected');

    // Then the session was read once
    expect(shared.reads.filter(key => key === SESSION_KEY)).toHaveLength(1);
    stop();
  });

  it('As a signed-out user whose shared store goes down, I am shown as unreachable, not signed out', async () => {
    // Given
    const stop = session.start();
    await published.until(() => auth.get().tag === 'Disconnected');
    expect(auth.get()).toEqual({ tag: 'Disconnected' });

    // When
    shared.setStatus('unavailable');

    // Then
    expect(auth.get()).toEqual({ tag: 'Unreachable' });
    stop();
  });

  it('As a signed-in user whose shared store goes down, I stay signed in', () => {
    // Given
    const stop = session.start();
    auth.set({ tag: 'Connected', session: CONNECTED_DETAIL });

    // When
    shared.setStatus('unavailable');

    // Then
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    stop();
  });

  it('As a returning user whose shared store comes back, my session is read again and running cores are told', async () => {
    // Given
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    shared.readError = UNREACHABLE;
    const stop = session.start();
    shared.setStatus('unavailable');
    await published.until(() => auth.get().tag === 'Unreachable');
    expect(auth.get()).toEqual({ tag: 'Unreachable' });
    const coreNotified = vi.fn();
    const unsubscribe = coreStorage.onStoredSessionChanged(coreNotified);

    // When
    shared.readError = null;
    shared.setStatus('available');

    // Then
    await published.until(() => auth.get().tag === 'Connected');
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    expect(coreNotified).toHaveBeenCalledTimes(1);
    stop();
    unsubscribe();
  });

  it('As a signed-out user whose core reported before the store went down, I am signed out again once it comes back', async () => {
    // Given a core that reported signed out before the store went down
    const stop = session.start();
    await published.until(() => auth.get().tag === 'Disconnected');
    coreReports({ tag: 'Disconnected' });
    shared.setStatus('unavailable');
    expect(auth.get()).toEqual({ tag: 'Unreachable' });

    // When the store comes back
    shared.setStatus('available');

    // Then the page shows signed out
    await published.until(() => auth.get().tag === 'Disconnected');
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
    stop();
  });

  it('As a returning user whose core reported before the store went down, I see my session once it comes back', async () => {
    // Given a core that reported signed out before the store went down
    const stop = session.start();
    await published.until(() => auth.get().tag === 'Disconnected');
    coreReports({ tag: 'Disconnected' });
    shared.setStatus('unavailable');
    expect(auth.get()).toEqual({ tag: 'Unreachable' });
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));

    // When the store comes back
    shared.setStatus('available');

    // Then the page shows the stored session
    await published.until(() => auth.get().tag === 'Connected');
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    stop();
  });

  it('As a page whose copy changes during the read on load, I read it again after that read, so the later read decides', async () => {
    // Given the load's read held in flight
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    shared.readGate = gate.promise;
    const sessionReads = (): number => shared.reads.filter(key => key === SHARED_CORE_SESSION_KEY).length;
    onTestFinished(session.start());

    // When a sign-in lands in the copy meanwhile
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    shared.changeFromOtherTab(SESSION_KEY, '0x010203');
    const readsWhileHeld = sessionReads();
    gate.resolve();
    await published.until(() => auth.get().tag === 'Connected');

    // Then the load's read and the change's own, one after the other
    expect(readsWhileHeld).toBe(1);
    expect(sessionReads()).toBe(2);
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a dotli integrator, starting session state twice keeps one subscription to the shared store', () => {
    // Given session state started once
    const first = session.start();
    const once = shared.statusListenerCount();

    // When it starts again
    const second = session.start();

    // Then
    expect(second).toBe(first);
    expect(shared.statusListenerCount()).toBe(once);
    first();
    expect(shared.statusListenerCount()).toBe(0);
  });

  it('As a dotli integrator, the host emits the typed session identity details from a connected auth state', () => {
    // Given
    const events = recordAuthStates();

    // When
    coreReports({
      tag: 'Connected',
      value: connectedSessionUiInfo(),
    });

    // Then
    expect(events).toEqual([{ tag: 'Connected', session: CONNECTED_DETAIL }]);
  });

  it('As a dotli integrator, the host dispatches the pairing presentation with its host context', () => {
    // Given
    const events = recordAuthStates();

    // When
    coreReports(
      { tag: 'Pairing', value: { deeplink: 'polkadotapp://pair?handshake=test' } },
      { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true },
    );

    // Then
    expect(events).toEqual([
      {
        tag: 'Pairing',
        deeplink: 'polkadotapp://pair?handshake=test',
        label: 'Polkadot Web',
        dotSuffix: false,
        hostGlobal: true,
      },
    ]);
  });

  it('As a dotli integrator, the host dispatches the authenticating state', () => {
    // Given
    const events = recordAuthStates();

    // When
    coreReports({ tag: 'Authenticating' });

    // Then
    expect(events).toEqual([{ tag: 'Authenticating' }]);
  });

  it('As a dotli integrator, the host caches the connected UI state and clears it with the session', async () => {
    // Given a core holding the stored session
    shared.entries.set(SESSION_KEY, '0x010203');
    const storage = coreStorage.adapters();
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When
    coreReports({
      tag: 'Connected',
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();

    // Then
    expect(JSON.parse(shared.entries.get(UI_STATE_CACHE_KEY) ?? '')).toEqual(CONNECTED_DETAIL);

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it('As a dotli integrator, the host clears the cached UI state on a disconnected auth state', async () => {
    // Given

    coreReports({
      tag: 'Connected',
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBeDefined();

    // When
    coreReports({ tag: 'Disconnected' });
    await flushMicrotasks();

    // Then
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it('As a dotli integrator, the host rehydrates the cached session UI state', async () => {
    // Given
    const storage = coreStorage.adapters();
    const events = recordAuthStates();

    // Nothing persisted: signed out, even with a stale cache entry.
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    const stopFirst = session.start();
    await published.until(() => events.length === 1);
    stopFirst();
    expect(events).toEqual([{ tag: 'Disconnected' }]);
    shared.entries.delete(UI_STATE_CACHE_KEY);

    // When: a login persists the session, then a reload reads it back.
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    coreReports({
      tag: 'Connected',
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    reloadPage();
    events.length = 0;

    onTestFinished(session.start());

    // Then
    await published.until(() => events.length === 1);
    expect(events).toEqual([{ tag: 'Connected', session: CONNECTED_DETAIL }]);
  });

  it('As a visitor without a saved session, boot ends the unknown state as signed out', async () => {
    // When
    onTestFinished(session.start());

    // Then
    await published.until(() => auth.get().tag === 'Disconnected');
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a user pairing when my copy changes, I keep my pairing and the change is left for the core', async () => {
    // Given a page whose core pairs
    onTestFinished(session.start());
    await published.until(() => auth.get().tag === 'Disconnected');
    coreReports({ tag: 'Pairing', value: { deeplink: 'polkadotapp://pair' } }, { label: 'myapp' });
    const reads = shared.reads.length;

    // When the copy loses what it held
    shared.changeFromOtherTab(SESSION_KEY, '');

    // Then nothing read the copy for the page, and the pairing stays on show
    expect(shared.reads).toHaveLength(reads);
    expect(auth.get().tag).toBe('Pairing');
  });

  it('As a dotli integrator, the host rehydrates a bare connected state when no cache exists', async () => {
    // Given
    const storage = coreStorage.adapters();
    const events = recordAuthStates();

    // When
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    onTestFinished(session.start());

    // Then
    await published.until(() => events.length === 1);
    expect(events).toEqual([{ tag: 'Connected', session: { connected: true } }]);
  });

  it('As a dotli integrator, the host degrades to a bare connected state when the cached UI state is malformed', async () => {
    // Given: a persisted session, but a UI-state cache whose fields no longer
    // match the expected shape (e.g. written by a different code version).
    const storage = coreStorage.adapters();
    const events = recordAuthStates();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify({ connected: true, publicKey: 42, liteUsername: null }));

    // When
    onTestFinished(session.start());

    // Then: the malformed cache is discarded instead of being laundered into
    // a typed session state with non-string fields.
    await published.until(() => events.length === 1);
    expect(events).toEqual([{ tag: 'Connected', session: { connected: true } }]);
  });

  it('As a returning user whose cached account is corrupt, I show as signed in without a name and nothing is captured', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const events = recordAuthStates();
    await coreStorage.adapters().writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    shared.entries.set(UI_STATE_CACHE_KEY, '{"connected":tr');

    // When
    onTestFinished(session.start());
    await published.until(() => events.length === 1);

    // Then
    expect(events).toEqual([{ tag: 'Connected', session: { connected: true } }]);
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).not.toHaveBeenCalled();
    expect(metrics.counted('shared_session.ui_cache')).toEqual([{ outcome: 'invalid', reason: 'json' }]);
  });

  it('As a local wallet user, I see my cached account at page load without a core', async () => {
    // Given
    wallet = {
      status: 'ok',
      entropy: new Uint8Array(16),
      identity: { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' },
      version: Uint8Array.of(1),
    };

    // When
    onTestFinished(session.start());

    // Then
    await published.until(() => auth.get().tag === 'Connected');
    expect(auth.get()).toEqual({
      tag: 'Connected',
      session: {
        connected: true,
        identityAccountId: `0x${'11'.repeat(32)}`,
        liteUsername: 'alice.42',
        primaryUsername: 'alice.42',
      },
    });
  });

  it('As a local wallet user before the first network read, I am shown signed in without a name', async () => {
    // Given
    wallet = { status: 'ok', entropy: new Uint8Array(16), identity: null, version: Uint8Array.of(1) };

    // When
    onTestFinished(session.start());

    // Then
    await published.until(() => auth.get().tag === 'Connected');
    expect(auth.get()).toEqual({ tag: 'Connected', session: { connected: true } });
  });

  it('As a local wallet user, my session never overwrites the paired session cache', async () => {
    // Given
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    localWallet = true;

    // When
    coreReports({ tag: 'Connected', value: connectedSessionUiInfo() });
    coreReports({ tag: 'Disconnected' });
    // A paired report is the positive control, so a write the local reports would make has landed before it.
    localWallet = false;
    const control = shared.nextWrite(UI_STATE_CACHE_KEY);
    coreReports({ tag: 'Connected', value: connectedSessionUiInfo() });
    await control;

    // Then
    expect(shared.writes.filter(([key]) => key === UI_STATE_CACHE_KEY)).toHaveLength(1);
    expect(shared.clears).not.toContain(UI_STATE_CACHE_KEY);
  });

  it('As a user whose login failed before the core saw it, I am shown why', () => {
    // When
    session.reportLoginFailure('worker fatal error: boom');

    // Then
    expect(auth.get()).toEqual({ tag: 'LoginFailed', kind: 'Other', reason: 'worker fatal error: boom' });
  });

  it('As a user whose logout found no core, I am shown signed out and my cached account stays for the next boot', async () => {
    // Given
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    auth.set({ tag: 'Connected', session: CONNECTED_DETAIL });

    // When
    session.reportSignedOut();
    const signedOut = auth.get();
    const control = shared.nextWrite(UI_STATE_CACHE_KEY);
    coreReports({ tag: 'Connected', value: connectedSessionUiInfo() });
    await control;

    // Then
    expect(signedOut).toEqual({ tag: 'Disconnected' });
    expect(shared.clears).not.toContain(UI_STATE_CACHE_KEY);
    expect(shared.writes.filter(([key]) => key === UI_STATE_CACHE_KEY)).toHaveLength(1);
  });

  it('As a page with no core whose copy received a sign-in, I show it with the cached account', async () => {
    // Given a signed-out page with no core
    onTestFinished(session.start());
    await published.until(() => auth.get().tag === 'Disconnected');

    // When the sign-in is stored and the page told of it
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));

    // Then the page shows the sign-in with its cached account
    await published.until(() => auth.get().tag === 'Connected');
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a page whose core pairs, I leave a stored sign-in for the core to report', async () => {
    // Given a signed-out page whose core is pairing
    onTestFinished(session.start());
    await published.until(() => auth.get().tag === 'Disconnected');
    coreReports({ tag: 'Pairing', value: { deeplink: 'polkadotapp://pair' } });
    const reads = shared.reads.length;

    // When a sign-in is installed
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));

    // Then nothing read the copy for the page, and the pairing stays on show
    expect(shared.reads).toHaveLength(reads);
    expect(auth.get().tag).toBe('Pairing');
  });

  it('As a signed-out page whose copy changed to hold nothing, I stay signed out', async () => {
    // Given a signed-out page whose auth states are recorded
    onTestFinished(session.start());
    await published.until(() => auth.get().tag === 'Disconnected');
    const states = recordAuthStates();

    // When the copy changes to hold nothing, then, as a control read after it, to hold a sign-in
    shared.changeFromOtherTab(SESSION_KEY, '');
    shared.changeFromOtherTab(SESSION_KEY, '0x010203');
    await published.until(() => states.length === 1);

    // Then the read of nothing showed nothing
    expect(states).toEqual([{ tag: 'Connected', session: { connected: true } }]);
  });

  it('As a user on a product page whose core signed me out and went, I sign in through the window and the sign-in shows at once', async () => {
    // Given a logout that booted a core, which reported the sign-out, then went with its last lease
    onTestFinished(session.start());
    await published.until(() => auth.get().tag === 'Disconnected');
    coreReports({ tag: 'Disconnected' });
    session.coresGone();

    // When the window's result is installed
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));

    // Then the page shows the sign-in
    await published.until(() => auth.get().tag === 'Connected');
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a user on a product page whose running core reports me signed out, I sign in through the window and the sign-in shows at once', async () => {
    // Given a page whose core is up and reported no sign-in
    onTestFinished(session.start());
    await published.until(() => auth.get().tag === 'Disconnected');
    coreReports({ tag: 'Disconnected' });

    // When Continue session installs the window's result, long before the core connects with it
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));

    // Then the page shows the account from its copy without waiting for the core
    await published.until(() => auth.get().tag === 'Connected');
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a page whose last core went while the copy changed, I read the copy again at once', async () => {
    // Given a page whose core speaks for it
    onTestFinished(session.start());
    await published.until(() => auth.get().tag === 'Disconnected');
    coreReports({ tag: 'Disconnected' });
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));

    // When the last core goes
    session.coresGone();

    // Then the page shows the sign-in from the copy
    await published.until(() => auth.get().tag === 'Connected');
  });

  it('As a page whose live core signed me out, I leave a session stored later for the core to pick up', async () => {
    // Given a page whose live core reported signed out
    onTestFinished(session.start());
    await published.until(() => auth.get().tag === 'Disconnected');
    coreReports({ tag: 'Disconnected' });

    // When a sign-in is installed
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));

    // Then the page stays signed out
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a page signed out elsewhere, I am shown signed out at once', () => {
    // Given a signed-in page
    auth.set({ tag: 'Connected', session: CONNECTED_DETAIL });

    // When a sign-out elsewhere is reported
    session.reportSignedOut();

    // Then the page shows signed out
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  describe('a sign-in made elsewhere', () => {
    it('As a page whose copy is empty while the flag says a sign-in exists, I say a sign-in made elsewhere waits for me', async () => {
      // Given a flag that reads present
      loadFlag = 'present';

      // When an empty copy loads
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Disconnected');

      // Then a sign-in made elsewhere waits
      expect(elsewhere).toBe(true);
    });

    it('As a page whose flag is gone, I offer a plain sign-in', async () => {
      // Given a flag that reads absent
      loadFlag = 'absent';

      // When an empty copy loads
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Disconnected');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a page whose flag cannot be read, I offer a plain sign-in', async () => {
      // Given a flag that reads unknown
      loadFlag = 'unknown';

      // When an empty copy loads
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Disconnected');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a page on a framed preview that shares no flag, I offer a plain sign-in even while the site has one', async () => {
      // Given the flag set on the site, as a framed preview's own presence reads it
      const jar = { read: () => 'has_session=1', write: () => undefined };
      loadFlag = await createPagePresence({
        shared: () => sharesFlag('framed-preview'),
        localhost: false,
        channel: () => {
          throw new Error('a framed preview reads no dev store');
        },
        jar,
      }).read();

      // When an empty copy loads
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Disconnected');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a user on the landing page whose copy is the main store, I am offered a plain sign-in since a flag over the empty copy is stale', async () => {
      // Given the landing page with a flag that reads present
      role = 'landing';
      loadFlag = 'present';

      // When an empty copy loads and a recheck reads the flag present
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Disconnected');
      session.reportFlag('present');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a page whose copy holds a session, I show it and say nothing waits elsewhere', async () => {
      // Given a flag that reads present over a stored session
      loadFlag = 'present';
      shared.entries.set(SESSION_KEY, '0x010203');

      // When the copy loads
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Connected');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a signed-out page left open, I read the flag on each recheck and it flips whether a sign-in waits for me', async () => {
      // Given a signed-out page whose flag read absent on load
      loadFlag = 'absent';
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Disconnected');

      // When a sign-in is made on another product
      session.reportFlag('present');

      // Then a sign-in waits
      expect(elsewhere).toBe(true);

      // When that sign-in is signed out
      session.reportFlag('absent');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a page that took the sign-in waiting elsewhere, I show it and say nothing waits any more', async () => {
      // Given a signed-out page where a sign-in made elsewhere waits
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Disconnected');
      expect(elsewhere).toBe(true);

      // When that sign-in is installed
      await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));
      await published.until(() => auth.get().tag === 'Connected');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a signed-in page, I read the flag on a recheck and nothing changes, and once I sign out nothing waits', () => {
      // Given a signed-in page
      auth.set({ tag: 'Connected', session: CONNECTED_DETAIL });

      // When a recheck reads the flag present
      session.reportFlag('present');

      // Then nothing waits
      expect(elsewhere).toBe(false);

      // When a sign-out elsewhere is reported
      session.reportSignedOut();

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a page whose session the core dropped, I do not take a flag read while I was signed in to say a sign-in waits', async () => {
      // Given a page signed in under a present flag
      loadFlag = 'present';
      shared.entries.set(SESSION_KEY, '0x010203');
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Connected');

      // When the core drops the session, such as one revoked on the phone
      coreReports({ tag: 'Disconnected' });

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a product page that asks for a sign-in, I get the auth state that prompts with the sign-in waiting already in it', async () => {
      // Given a signed-out page where a sign-in made elsewhere waits, with each auth state recorded
      onTestFinished(session.start());
      await published.until(() => auth.get().tag === 'Disconnected');
      const seen: boolean[] = [];
      auth.subscribe(() => {
        seen.push(elsewhere);
      });

      // When a product's login request starts pairing
      coreReports({ tag: 'Pairing', value: { deeplink: 'polkadotapp://pair' } });

      // Then the pairing state came with the sign-in waiting
      expect(auth.get().tag).toBe('Pairing');
      expect(seen).toEqual([true]);
    });
  });
});

describe('core auth presenter', () => {
  it('As a dotli integrator, the host hands each state the core reports to session state with its pairing presentation', () => {
    // Given
    const reports: [AuthState, PairingPresentation][] = [];
    const authStateChanged = createAuthStateChanged(
      'Polkadot Web',
      { dotSuffix: false, hostGlobal: true },
      {
        reportCoreAuthState(state, pairing) {
          reports.push([state, pairing]);
        },
      },
    );

    // When
    authStateChanged({ tag: 'Authenticating' });

    // Then
    expect(reports).toEqual([
      [{ tag: 'Authenticating' }, { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true }],
    ]);
  });

  it('As a dotli integrator, a core that went out of service no longer reports to session state', () => {
    // Given
    let inService = true;
    const reports: AuthState[] = [];
    const authStateChanged = createAuthStateChanged(
      'doom',
      { inService: () => inService },
      {
        reportCoreAuthState(state) {
          reports.push(state);
        },
      },
    );
    authStateChanged({ tag: 'Authenticating' });

    // When
    inService = false;
    authStateChanged({ tag: 'Disconnected' });

    // Then
    expect(reports).toEqual([{ tag: 'Authenticating' }]);
  });
});
