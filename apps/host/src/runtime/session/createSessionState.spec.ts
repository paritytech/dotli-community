// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { SHARED_CORE_SESSION_KEY } from '@dotli/protocol';
import type { AuthState, SessionUiInfo } from '@parity/truapi-host';
import { createCoreStorage, type HostCoreStorage } from './createCoreStorage.js';
import { createNonOwnerSignInFlag } from './signInFlag.js';
import { createSessionState, type PairingPresentation, type SessionState } from './createSessionState.js';
import { atom, type WritableAtom } from 'nanostores';
import { createChanges } from '../../testing/changes.js';
import { recordNotified } from '../../testing/recordNotified.js';
import type { LocalWalletBoot } from '../createWalletBoot.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { waitForStatus } from '@dotli/shared';
import { catchError } from '@dotli/shared/testing';
import { createFakeSharedSessionStore, type FakeSharedSessionStore } from './createCoreStorage.fake.js';
import type { DotliAuthState, Presence } from './types.js';
import { createFakeSessionPresence, getUnservedChannel, type FakeSessionPresence } from './createPagePresence.fake.js';
import { createPagePresence } from './createPagePresence.js';
import { isResumeOffered, isFlagShared, type PageRole } from '../pageRole.js';

const SESSION_KEY = SHARED_CORE_SESSION_KEY;
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;
const AUTH_SESSION_KEY = { tag: 'AuthSession' as const };
const UNREACHABLE = new Error('protocol iframe never listened');
const RESTORING: DotliAuthState = { tag: 'Restoring' };

// The core reports these as `Bytes32` hex, so the UI state carries them through unencoded.
const SESSION_PUBLIC_KEY = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' as const;
const SESSION_IDENTITY_ACCOUNT_ID = '0xa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf' as const;

function buildConnectedSessionUiInfo(): SessionUiInfo {
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
let auth: WritableAtom<DotliAuthState>;
let session: SessionState;
let presence: FakeSessionPresence;
/** The flag as the load's restore read it. */
let loadFlag: Presence;
/** Whether the page last said a sign-in made elsewhere waits for it. */
let elsewhere: boolean;
/** What the page is to sign-in. */
let role: PageRole;

/** Waits on the auth store, checking again at each state it publishes rather than on a timer. */
function waitForAuth(met: () => boolean): Promise<void> {
  const changes = createChanges();
  const stop = auth.listen(changes.notify);
  return changes.until(met).finally(stop);
}

/** Resolves once a session read of the shared store reports that it failed, checked at each read. */
function waitForFailedRead(): Promise<void> {
  const changes = createChanges();
  let failed = false;
  const stop = coreStorage.subscribeSessionReads(next => {
    failed ||= next;
    changes.notify();
  });
  return changes.until(() => failed).finally(stop);
}

/** The core reporting a state, as its auth presenter does. */
function reportFromCore(state: AuthState, pairing: PairingPresentation = PAIRING): void {
  session.reportCoreAuthState(state, pairing);
}

describe('session state', () => {
  beforeEach(() => {
    shared = createFakeSharedSessionStore();
    presence = createFakeSessionPresence({ state: 'present' });
    coreStorage = createCoreStorage({
      shared,
      flag: createNonOwnerSignInFlag({ presence, readStoredSignIn: () => Promise.resolve('none') }),
    });
    wallet = null;
    localWallet = false;
    loadFlag = 'present';
    elsewhere = false;
    role = 'page';
    // Each test is a fresh page, whose auth state is Restoring until the saved session is read.
    auth = atom<DotliAuthState>(RESTORING);
    reloadPage();
  });

  /** The page loading again over the same store: its auth state is Restoring and its restore reads once more. */
  function reloadPage(): void {
    auth.set(RESTORING);
    // Reads the session once per load and keeps the answer.
    let loadRead: ReturnType<HostCoreStorage['readSession']> | undefined;
    session = createSessionState({
      store: coreStorage,
      restore,
      auth: {
        store: auth,
        set: next => {
          auth.set(next);
        },
      },
      setElsewhere,
      isLocalWallet: () => localWallet,
      isResumeOffered: () => isResumeOffered(role),
    });

    async function restore() {
      loadRead ??= coreStorage.readSession();
      return {
        local: wallet,
        session: await loadRead,
        wallet: wallet ?? { status: 'none' as const },
        presence: loadFlag,
      };
    }

    function setElsewhere(next: boolean): void {
      elsewhere = next;
    }
  }

  it('As a returning user whose saved session could not be read, I get disconnected and am shown unreachable while my cached account stays', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    shared.readError = UNREACHABLE;
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When
    const unreachable = waitForStatus(auth, state => state.tag === 'Unreachable');
    reportFromCore({ tag: 'Disconnected' });
    await unreachable;

    // Then
    expect(auth.get()).toEqual({ tag: 'Unreachable' });
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(JSON.stringify(CONNECTED_DETAIL));
  });

  it('As a returning user whose store answers again, I get disconnected and see a plain logout', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    shared.readError = UNREACHABLE;
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    shared.readError = null;
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When
    reportFromCore({ tag: 'Disconnected' });

    // Then
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a returning user, I open the page and my saved session is read at once without waking running cores', async () => {
    // Given
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    const coreNotified = vi.fn();
    onTestFinished(coreStorage.subscribeStoredSession(coreNotified));

    // When
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Connected');

    // Then
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    expect(coreNotified).not.toHaveBeenCalled();
  });

  it('As a returning user, I open the page and see the session the restore read without a second read', async () => {
    // Given a stored session and its account
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));

    // When the session state starts
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Connected');

    // Then the session was read once
    expect(shared.reads.filter(key => key === SESSION_KEY)).toHaveLength(1);
  });

  it('As a signed-out user, I lose the shared store and am shown unreachable, not signed out', async () => {
    // Given
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');

    // When
    shared.setStatus('unavailable');

    // Then
    expect(auth.get()).toEqual({ tag: 'Unreachable' });
  });

  it('As a user whose saved session could not be read, I ask to read it again and am shown signed out once the store answers', async () => {
    // Given
    shared.readError = UNREACHABLE;
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Unreachable');
    shared.readError = null;

    // When
    await session.retryRead();

    // Then
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a user whose saved session could not be read, I ask to read it again while the store still fails and stay unreachable', async () => {
    // Given
    shared.readError = UNREACHABLE;
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Unreachable');

    // When
    const retried = session.retryRead();

    // Then
    await expect(retried).resolves.toBeUndefined();
    expect(auth.get()).toEqual({ tag: 'Unreachable' });
  });

  it('As a signed-out user, I ask to read my session again and nothing is read', async () => {
    // Given
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    const reads = shared.reads.filter(key => key === SESSION_KEY).length;

    // When
    await session.retryRead();

    // Then
    expect(shared.reads.filter(key => key === SESSION_KEY)).toHaveLength(reads);
  });

  it('As a user shown unreachable, I see a core read my session and am shown it', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    shared.readError = UNREACHABLE;
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    reportFromCore({ tag: 'Disconnected' });
    await waitForStatus(auth, state => state.tag === 'Unreachable');
    shared.readError = null;
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));

    // When
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    await waitForStatus(auth, state => state.tag === 'Connected');

    // Then
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a signed-in user, I lose the shared store and stay signed in', () => {
    // Given
    onTestFinished(session.start());
    auth.set({ tag: 'Connected', session: CONNECTED_DETAIL });

    // When
    shared.setStatus('unavailable');

    // Then
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a returning user, I get the shared store back and my session is read again while running cores are told', async () => {
    // Given
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    shared.readError = UNREACHABLE;
    onTestFinished(session.start());
    shared.setStatus('unavailable');
    await waitForStatus(auth, state => state.tag === 'Unreachable');
    const coreNotified = vi.fn();
    onTestFinished(coreStorage.subscribeStoredSession(coreNotified));

    // When
    shared.readError = null;
    shared.setStatus('available');
    await waitForStatus(auth, state => state.tag === 'Connected');

    // Then
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    expect(coreNotified).toHaveBeenCalledTimes(1);
  });

  it('As a signed-out user whose core reported before the store went down, I get the store back and am signed out again', async () => {
    // Given a core that reported signed out before the store went down
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    reportFromCore({ tag: 'Disconnected' });
    shared.setStatus('unavailable');

    // When the store comes back
    shared.setStatus('available');
    await waitForStatus(auth, state => state.tag === 'Disconnected');

    // Then the page shows signed out
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a returning user whose core reported before the store went down, I get the store back and see my session', async () => {
    // Given a core that reported signed out before the store went down
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    reportFromCore({ tag: 'Disconnected' });
    shared.setStatus('unavailable');
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));

    // When the store comes back
    shared.setStatus('available');
    await waitForStatus(auth, state => state.tag === 'Connected');

    // Then the page shows the stored session
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a user whose copy changes during the read on load, I open the page and the copy is read again after that read so the later read decides', async () => {
    // Given the load's read held in flight
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    shared.readGate = gate.promise;
    const countSessionReads = (): number => shared.reads.filter(key => key === SHARED_CORE_SESSION_KEY).length;
    onTestFinished(session.start());

    // When a sign-in lands in the copy meanwhile
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    shared.changeFromOtherTab(SESSION_KEY, '0x010203');
    const readsWhileHeld = countSessionReads();
    gate.resolve();
    await waitForAuth(() => auth.get().tag === 'Connected');

    // Then the load's read and the change's own, one after the other
    expect(readsWhileHeld).toBe(1);
    expect(countSessionReads()).toBe(2);
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a user whose page refreshes its session after a change, I see the cached account read only after the session', async () => {
    // Given a page started and settled with no session, then every read held and the first one watched
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    onTestFinished(() => {
      gate.resolve();
    });
    shared.readGate = gate.promise;
    shared.reads.length = 0;
    const started = Promise.withResolvers<string>();
    const read = shared.read.bind(shared);
    shared.read = key => {
      started.resolve(key);
      return read(key);
    };
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));

    // When a sign-in lands through the shared store
    shared.changeFromOtherTab(SESSION_KEY, '0x010203');
    await started.promise;

    // Then only the session is read while the gate is held
    expect(shared.reads).toEqual([SESSION_KEY]);
  });

  it('As a visitor with no stored session beside a corrupt cached account, I load the page and nothing is counted', async () => {
    // Given no stored session beside a corrupt cached account
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    shared.entries.set(UI_STATE_CACHE_KEY, '{"connected":tr');

    // When the session state starts
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag !== 'Restoring');

    // Then the cached account is dropped unparsed
    expect(metrics.counted('shared_session.ui_cache')).toEqual([]);
  });

  it('As a dotli integrator, I start session state twice and it keeps one subscription to the shared store', () => {
    // Given session state started once
    const first = session.start();
    const once = shared.statusListenerCount();

    // When it starts again
    const second = session.start();

    // Then
    expect(second).toBe(first);
    expect(shared.statusListenerCount()).toBe(once);

    // When the one stop runs
    first();

    // Then
    expect(shared.statusListenerCount()).toBe(0);
  });

  it('As a dotli integrator, I dispose session state and a session read that failed after it leaves a core sign-out a plain logout', async () => {
    // Given a disposed session state
    const storage = coreStorage.createAdapters();
    session.dispose();

    // When the saved session cannot be read and the core then reports signed out
    shared.readError = UNREACHABLE;
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    reportFromCore({ tag: 'Disconnected' });

    // Then the page shows a plain logout rather than an unreachable store
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a dotli integrator, I dispose started session state and it no longer follows the shared store or its stored session', async () => {
    // Given started session state on a signed-out page
    session.start();
    await waitForStatus(auth, state => state.tag === 'Disconnected');

    // When it is disposed and the shared store goes down after it
    session.dispose();
    shared.setStatus('unavailable');

    // Then the page stays signed out and no listener of the store's status or stored-session changes is left
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
    expect(shared.statusListenerCount()).toBe(0);
  });

  it('As a dotli integrator, I dispose started session state twice and see no error', () => {
    // Given started session state disposed once
    session.start();
    session.dispose();

    // When it is disposed again
    const thrown = catchError(() => {
      session.dispose();
    });

    // Then nothing threw
    expect(thrown).toBeUndefined();
  });

  it.each<{ label: string; state: AuthState; pairing: PairingPresentation; published: DotliAuthState }>([
    {
      label: 'a connected core state and the typed session identity details are published',
      state: { tag: 'Connected', value: buildConnectedSessionUiInfo() },
      pairing: PAIRING,
      published: { tag: 'Connected', session: CONNECTED_DETAIL },
    },
    {
      label: 'a pairing core state and it is published with its host context',
      state: { tag: 'Pairing', value: { deeplink: 'polkadotapp://pair?handshake=test' } },
      pairing: { label: 'Polkadot Web', dotSuffix: false, hostGlobal: true },
      published: {
        tag: 'Pairing',
        deeplink: 'polkadotapp://pair?handshake=test',
        label: 'Polkadot Web',
        dotSuffix: false,
        hostGlobal: true,
      },
    },
    {
      label: 'an authenticating core state and it is published',
      state: { tag: 'Authenticating' },
      pairing: PAIRING,
      published: { tag: 'Authenticating' },
    },
  ])('As a dotli integrator, I pass on $label', ({ state, pairing, published }) => {
    // Given
    const events = recordNotified(auth);

    // When
    reportFromCore(state, pairing);

    // Then
    expect(events).toEqual([published]);
  });

  it('As a dotli integrator, I pass on a connected core state and its UI state is cached until the session is cleared', async () => {
    // Given a core holding the stored session
    shared.entries.set(SESSION_KEY, '0x010203');
    const storage = coreStorage.createAdapters();
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When
    const cached = shared.nextWrite(UI_STATE_CACHE_KEY);
    reportFromCore({
      tag: 'Connected',
      value: buildConnectedSessionUiInfo(),
    });
    await cached;

    // Then
    expect(JSON.parse(shared.entries.get(UI_STATE_CACHE_KEY) ?? '')).toEqual(CONNECTED_DETAIL);

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it('As a dotli integrator, I pass on a disconnected core state and the cached UI state is cleared', async () => {
    // Given
    const cached = shared.nextWrite(UI_STATE_CACHE_KEY);
    reportFromCore({
      tag: 'Connected',
      value: buildConnectedSessionUiInfo(),
    });
    await cached;

    // When
    const cleared = shared.nextClear(UI_STATE_CACHE_KEY);
    reportFromCore({ tag: 'Disconnected' });
    await cleared;

    // Then
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it('As a visitor with only a stale cached account, I load the page and am signed out', async () => {
    // Given nothing persisted beside a stale cache entry
    const events = recordNotified(auth);
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));

    // When
    onTestFinished(session.start());
    await waitForAuth(() => events.length === 1);

    // Then
    expect(events).toEqual([{ tag: 'Disconnected' }]);
  });

  it.each<{ label: string; cache: string | null; counted: unknown[] }>([
    { label: 'no cached account', cache: null, counted: [] },
    {
      label: 'a cached account of a shape that no longer matches',
      // A cache from another code version is discarded instead of being laundered into a typed session state with
      // non-string fields.
      cache: JSON.stringify({ connected: true, publicKey: 42, liteUsername: null }),
      counted: [],
    },
    {
      label: 'a corrupt cached account',
      cache: '{"connected":tr',
      counted: [{ outcome: 'invalid', reason: 'json' }],
    },
  ])(
    'As a returning user with $label, I open the page over my stored session and show as signed in without a name with nothing captured',
    async ({ cache, counted }) => {
      // Given a stored session beside the row's cached account
      const metrics = bindRecordingSentry({ onFinished: onTestFinished });
      const captures = { exception: vi.fn(), expected: vi.fn() };
      onTestFinished(bindCaptureSink(captures));
      const events = recordNotified(auth);
      await coreStorage.createAdapters().writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
      if (cache !== null) {
        shared.entries.set(UI_STATE_CACHE_KEY, cache);
      }

      // When the session state starts
      onTestFinished(session.start());
      await waitForAuth(() => events.length === 1);

      // Then a bare connected state is published, and only a corrupt cache is counted
      expect(events).toEqual([{ tag: 'Connected', session: { connected: true } }]);
      expect(captures.exception).not.toHaveBeenCalled();
      expect(captures.expected).not.toHaveBeenCalled();
      expect(metrics.counted('shared_session.ui_cache')).toEqual(counted);
    },
  );

  it('As a local wallet user, I open the page and see my cached account without a core', async () => {
    // Given
    wallet = {
      status: 'ok',
      entropy: new Uint8Array(16),
      identity: { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' },
      version: Uint8Array.of(1),
    };

    // When
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Connected');

    // Then
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

  it('As a local wallet user before the first network read, I open the page and am shown signed in without a name', async () => {
    // Given
    wallet = { status: 'ok', entropy: new Uint8Array(16), identity: null, version: Uint8Array.of(1) };

    // When
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Connected');

    // Then
    expect(auth.get()).toEqual({ tag: 'Connected', session: { connected: true } });
  });

  it('As a local wallet user, I sign in and out and the paired session cache is never overwritten', async () => {
    // Given
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    localWallet = true;

    // When
    reportFromCore({ tag: 'Connected', value: buildConnectedSessionUiInfo() });
    reportFromCore({ tag: 'Disconnected' });
    // A paired report is the positive control, so a write the local reports would make has landed before it.
    localWallet = false;
    const control = shared.nextWrite(UI_STATE_CACHE_KEY);
    reportFromCore({ tag: 'Connected', value: buildConnectedSessionUiInfo() });
    await control;

    // Then
    expect(shared.writes.filter(([key]) => key === UI_STATE_CACHE_KEY)).toHaveLength(1);
    expect(shared.clears).not.toContain(UI_STATE_CACHE_KEY);
  });

  it('As a user whose login failed before the core saw it, I try to sign in and am shown why', () => {
    // Given a page still restoring its session

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
    reportFromCore({ tag: 'Connected', value: buildConnectedSessionUiInfo() });
    await control;

    // Then
    expect(signedOut).toEqual({ tag: 'Disconnected' });
    expect(shared.clears).not.toContain(UI_STATE_CACHE_KEY);
    expect(shared.writes.filter(([key]) => key === UI_STATE_CACHE_KEY)).toHaveLength(1);
  });

  it.each<{ label: string; prepareCores: () => void }>([
    {
      label: 'signed-out user with no core',
      prepareCores() {
        // No core has reported.
      },
    },
    {
      label: 'user on a product page whose core signed me out and went',
      prepareCores() {
        reportFromCore({ tag: 'Disconnected' });
        session.reportCoresGone();
      },
    },
    {
      label: 'user on a product page whose running core reports me signed out',
      prepareCores() {
        reportFromCore({ tag: 'Disconnected' });
      },
    },
  ])(
    'As a $label, I sign in elsewhere and the sign-in shows at once with its cached account',
    async ({ prepareCores }) => {
      // Given a signed-out page whose cores are as the row has them
      onTestFinished(session.start());
      await waitForStatus(auth, state => state.tag === 'Disconnected');
      prepareCores();

      // When the sign-in is installed, long before any core connects with it
      await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));
      await waitForStatus(auth, state => state.tag === 'Connected');

      // Then the page shows the sign-in with its cached account, without waiting for a core
      expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    },
  );

  it('As a user whose core pairs, I get a sign-in stored and it is left for the core to report', async () => {
    // Given a signed-out page whose core is pairing
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    reportFromCore({ tag: 'Pairing', value: { deeplink: 'polkadotapp://pair' } });
    const reads = shared.reads.length;

    // When a sign-in is installed
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));

    // Then nothing read the copy for the page, and the pairing stays on show
    expect(shared.reads).toHaveLength(reads);
    expect(auth.get().tag).toBe('Pairing');
  });

  it('As a signed-out user, I see the copy change to hold nothing and stay signed out', async () => {
    // Given a signed-out page whose auth states are recorded
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    const states = recordNotified(auth);

    // When the copy changes to hold nothing, and to hold a sign-in as a control read after it
    shared.changeFromOtherTab(SESSION_KEY, '');
    shared.changeFromOtherTab(SESSION_KEY, '0x010203');
    await waitForAuth(() => states.length === 1);

    // Then the read of nothing showed nothing
    expect(states).toEqual([{ tag: 'Connected', session: { connected: true } }]);
  });

  it('As a user whose copy changed while a core spoke for me, I lose my last core and the copy is read again at once', async () => {
    // Given a page whose core speaks for it
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    reportFromCore({ tag: 'Disconnected' });
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));

    // When the last core goes
    session.reportCoresGone();
    await waitForStatus(auth, state => state.tag === 'Connected');

    // Then the page shows the sign-in from the copy
    expect(auth.get()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a user in the sign-in window, I watch the core report and see its own report rather than the saved copy', async () => {
    // Given a page whose saved copy shows a sign-in before any core reported
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Connected');
    const beforeCore = session.coreReport.get();

    // When a core reports the session and the page's last core goes after it
    reportFromCore({ tag: 'Connected', value: buildConnectedSessionUiInfo() });
    const reported = session.coreReport.get();
    session.reportCoresGone();
    const afterTheCores = session.coreReport.get();

    // Then only the core's own report showed, mapped as the page shows it
    expect([beforeCore, reported, afterTheCores]).toEqual([
      null,
      { tag: 'Connected', session: CONNECTED_DETAIL },
      null,
    ]);
  });

  it('As a user whose core signed me out, I see a stored sign-in and lose it once the store drops it', async () => {
    // Given a page whose core reported signed out and whose copy shows a sign-in stored since
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    reportFromCore({ tag: 'Disconnected' });
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));
    await waitForStatus(auth, state => state.tag === 'Connected');

    // When the store drops the session, as a core that cannot decode it does
    await coreStorage.dropSessionIf('0x010203');
    await waitForStatus(auth, state => state.tag === 'Disconnected');

    // Then the page shows the core's own report again
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a user whose sign-in failed, I see a stored sign-in and see the failure again once the store drops it', async () => {
    // Given a page whose core reported a failed sign-in and whose copy shows a sign-in stored since
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    reportFromCore({ tag: 'LoginFailed', value: { kind: 'Other', reason: 'boom' } });
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));
    await waitForStatus(auth, state => state.tag === 'Connected');

    // When the store drops the session
    await coreStorage.dropSessionIf('0x010203');
    await waitForStatus(auth, state => state.tag === 'LoginFailed');

    // Then the page shows the core's failure again
    expect(auth.get()).toEqual({ tag: 'LoginFailed', kind: 'Other', reason: 'boom' });
  });

  it('As a user whose core reported while the store was down, I see a stored sign-in and am signed out once the store drops it', async () => {
    // Given a page whose core reported signed out while the store could not be read, and whose copy shows a sign-in
    // stored once the store answers again
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    shared.readError = UNREACHABLE;
    await coreStorage.createAdapters().readCoreStorage(AUTH_SESSION_KEY);
    reportFromCore({ tag: 'Disconnected' });
    await waitForStatus(auth, state => state.tag === 'Unreachable');
    shared.readError = null;
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));
    await waitForStatus(auth, state => state.tag === 'Connected');

    // When the store drops the session
    await coreStorage.dropSessionIf('0x010203');
    await waitForStatus(auth, state => state.tag === 'Disconnected');

    // Then the page shows signed out, as the read that withdrew the sign-in has answered
    expect(auth.get()).toEqual({ tag: 'Disconnected' });
  });

  it('As a user whose core signed me out, I see a stored sign-in and keep it while the store cannot be read', async () => {
    // Given a page whose core reported signed out and whose copy shows a sign-in stored since, its states recorded
    onTestFinished(session.start());
    await waitForStatus(auth, state => state.tag === 'Disconnected');
    reportFromCore({ tag: 'Disconnected' });
    await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));
    await waitForStatus(auth, state => state.tag === 'Connected');
    const states = recordNotified(auth);
    const failedRead = waitForFailedRead();

    // When the store becomes unreadable and the copy changes, then answers again with a control read after that one
    shared.readError = UNREACHABLE;
    shared.changeFromOtherTab(SESSION_KEY, '');
    await failedRead;
    shared.readError = null;
    shared.changeFromOtherTab(SESSION_KEY, '0x040506');
    await waitForAuth(() => states.length === 1);

    // Then the failed read showed nothing, and the control read showed the session with its cached account
    expect(states).toEqual([{ tag: 'Connected', session: CONNECTED_DETAIL }]);
  });

  describe('a sign-in made elsewhere', () => {
    it.each<{ label: string; readLoadFlag: () => Promise<Presence>; waits: boolean }>([
      {
        label:
          'whose copy is empty while the flag says a sign-in exists, I open the page and am told a sign-in made elsewhere waits',
        readLoadFlag: () => Promise.resolve('present'),
        waits: true,
      },
      {
        label: 'whose flag is gone, I open the page and am offered a plain sign-in',
        readLoadFlag: () => Promise.resolve('absent'),
        waits: false,
      },
      {
        label: 'whose flag cannot be read, I open the page and am offered a plain sign-in',
        readLoadFlag: () => Promise.resolve('unknown'),
        waits: false,
      },
      {
        label:
          'on a framed preview that shares no flag, I open the page and am offered a plain sign-in even while the site has one',
        // The flag set on the site, as a framed preview's own presence reads it.
        readLoadFlag: () =>
          createPagePresence({
            isShared: () => isFlagShared('framed-preview'),
            localhost: false,
            channel: getUnservedChannel,
            jar: { read: () => 'has_session=1', write: () => undefined },
          }).read(),
        waits: false,
      },
    ])('As a user $label', async ({ readLoadFlag, waits }) => {
      // Given the flag as the load's restore reads it
      loadFlag = await readLoadFlag();

      // When an empty copy loads
      onTestFinished(session.start());
      await waitForStatus(auth, state => state.tag === 'Disconnected');

      // Then a sign-in made elsewhere waits only where the flag says one exists and the page shares it
      expect(elsewhere).toBe(waits);
    });

    it('As a user on the landing page whose copy is the main store, I open it under a present flag and am offered a plain sign-in since that flag is stale', async () => {
      // Given the landing page with a flag that reads present
      role = 'landing';
      loadFlag = 'present';

      // When an empty copy loads and a recheck reads the flag present
      onTestFinished(session.start());
      await waitForStatus(auth, state => state.tag === 'Disconnected');
      session.reportFlag('present');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a returning user whose copy holds a session, I open the page and see it with nothing waiting elsewhere', async () => {
      // Given a flag that reads present over a stored session
      loadFlag = 'present';
      shared.entries.set(SESSION_KEY, '0x010203');

      // When the copy loads
      onTestFinished(session.start());
      await waitForStatus(auth, state => state.tag === 'Connected');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a signed-out user with the page left open, I come back after each sign-in or sign-out elsewhere and whether a sign-in waits follows the flag', async () => {
      // Given a signed-out page whose flag read absent on load
      loadFlag = 'absent';
      onTestFinished(session.start());
      await waitForStatus(auth, state => state.tag === 'Disconnected');

      // When a sign-in is made on another product
      session.reportFlag('present');

      // Then a sign-in waits
      expect(elsewhere).toBe(true);

      // When that sign-in is signed out
      session.reportFlag('absent');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a signed-out user with a sign-in waiting elsewhere, I take it and nothing waits any more', async () => {
      // Given a signed-out page where a sign-in made elsewhere waits
      onTestFinished(session.start());
      await waitForStatus(auth, state => state.tag === 'Disconnected');

      // When that sign-in is installed
      await coreStorage.installSession('0x010203', JSON.stringify(CONNECTED_DETAIL));
      await waitForStatus(auth, state => state.tag === 'Connected');

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a signed-in user, I come back to the page and later sign out and nothing waits at either point', () => {
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

    it('As a signed-in user whose core drops my session, I am signed out and a flag read while I was signed in does not say a sign-in waits', async () => {
      // Given a page signed in under a present flag
      loadFlag = 'present';
      shared.entries.set(SESSION_KEY, '0x010203');
      onTestFinished(session.start());
      await waitForStatus(auth, state => state.tag === 'Connected');

      // When the core drops the session, such as one revoked on the phone
      reportFromCore({ tag: 'Disconnected' });

      // Then nothing waits
      expect(elsewhere).toBe(false);
    });

    it('As a user on a product page that asks for a sign-in, I start pairing and the prompt already carries the sign-in waiting', async () => {
      // Given a signed-out page where a sign-in made elsewhere waits, with each auth state recorded
      onTestFinished(session.start());
      await waitForStatus(auth, state => state.tag === 'Disconnected');
      const seen: boolean[] = [];
      onTestFinished(
        auth.listen(() => {
          seen.push(elsewhere);
        }),
      );

      // When a product's login request starts pairing
      reportFromCore({ tag: 'Pairing', value: { deeplink: 'polkadotapp://pair' } });

      // Then the pairing state came with the sign-in waiting
      expect(auth.get().tag).toBe('Pairing');
      expect(seen).toEqual([true]);
    });
  });
});
