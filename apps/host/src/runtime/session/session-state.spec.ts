// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { SHARED_CORE_SESSION_KEY } from '@dotli/protocol';
import type { AuthState, SessionUiInfo } from '@parity/truapi-host';
import { createAuthStateChanged, type DotliAuthState } from './auth-state.js';
import { createCoreStorage, type HostCoreStorage } from './core-storage.js';
import { createSessionState, type PairingPresentation, type SessionState } from './session-state.js';
import { createSyncStore, type SyncStore } from '@dotli/shared';
import { createChanges } from '../../testing/changes.js';
import type { LocalWalletBoot } from '../wallet-boot.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createFakeSharedSessionStore, type FakeSharedSessionStore } from './core-storage.fake.js';

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
    coreStorage = createCoreStorage({ shared });
    wallet = null;
    localWallet = false;
    // Each test is a fresh page, whose auth state is Restoring until the saved session is read.
    auth = createSyncStore<DotliAuthState>('auth', { tag: 'Restoring' }, { equals: () => false });
    session = createSessionState({
      store: coreStorage,
      readWallet: () => Promise.resolve(wallet),
      auth,
      isLocalWallet: () => localWallet,
    });
  });

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

  it('As a dotli integrator, a refresh asked during a read waits for it, so the later read decides', async () => {
    // Given
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    shared.readGate = gate.promise;
    const sessionReads = (): number => shared.reads.filter(key => key === SHARED_CORE_SESSION_KEY).length;
    const first = session.refresh();
    await flushMicrotasks();

    // When
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    const second = session.refresh();
    await flushMicrotasks();
    const readsWhileHeld = sessionReads();
    gate.resolve();
    await Promise.all([first, second]);

    // Then
    expect(readsWhileHeld).toBe(1);
    expect(sessionReads()).toBe(2);
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a dotli integrator, starting session state twice keeps one subscription to the shared store', () => {
    // When
    const first = session.start();
    const second = session.start();

    // Then
    expect(second).toBe(first);
    expect(shared.statusListenerCount()).toBe(1);
    first();
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
    // Given
    const storage = coreStorage.adapters();

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
    await session.refresh();
    await published.until(() => events.length === 1);
    expect(events).toEqual([{ tag: 'Disconnected' }]);
    shared.entries.delete(UI_STATE_CACHE_KEY);

    // When: a login persists the session, then a reload reads it back.
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    coreReports({
      tag: 'Connected',
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    auth.reset();
    events.length = 0;

    await session.refresh();

    // Then
    await published.until(() => events.length === 1);
    expect(events).toEqual([{ tag: 'Connected', session: CONNECTED_DETAIL }]);
  });

  it('As a visitor without a saved session, boot ends the unknown state as signed out', async () => {
    // When
    await session.refresh();

    // Then
    await published.until(() => auth.get().tag === 'Disconnected');
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a user pairing before boot read the saved session, finding none leaves my pairing alone', async () => {
    // Given
    coreReports({ tag: 'Pairing', value: { deeplink: 'polkadotapp://pair' } }, { label: 'myapp' });

    // When
    await session.refresh();

    // Then
    expect(auth.get().tag).toBe('Pairing');
  });

  it('As a user whose session the core already reported, the saved copy read later does not override it', async () => {
    // Given
    const storage = coreStorage.adapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    coreReports({ tag: 'Disconnected' }, { label: 'myapp' });

    // When
    await session.refresh();

    // Then
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a dotli integrator, the host rehydrates a bare connected state when no cache exists', async () => {
    // Given
    const storage = coreStorage.adapters();
    const events = recordAuthStates();

    // When
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    await session.refresh();

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
    await session.refresh();

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
    await session.refresh();

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
    };

    // When
    await session.refresh();

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
    wallet = { status: 'ok', entropy: new Uint8Array(16), identity: null };

    // When
    await session.refresh();

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
    session.reportLogoutWithoutCore();
    const signedOut = auth.get();
    const control = shared.nextWrite(UI_STATE_CACHE_KEY);
    coreReports({ tag: 'Connected', value: connectedSessionUiInfo() });
    await control;

    // Then
    expect(signedOut).toEqual({ tag: 'Disconnected' });
    expect(shared.clears).not.toContain(UI_STATE_CACHE_KEY);
    expect(shared.writes.filter(([key]) => key === UI_STATE_CACHE_KEY)).toHaveLength(1);
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
