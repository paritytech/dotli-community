// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SHARED_CORE_SESSION_KEY } from '@dotli/protocol';
import { createCoreStorage, type HostCoreStorage } from './createCoreStorage.js';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { createFakeSharedSessionStore, type FakeSharedSessionStore } from './createCoreStorage.fake.js';
import { createDeferred } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import { createFakeSessionPresence, type FakeSessionPresence } from './createPagePresence.fake.js';
import type { SessionPresence } from './types.js';
import { createNonOwnerSignInFlag, createOwnerSignInFlag, type StoredSignIn } from './signInFlag.js';

const SESSION_KEY = SHARED_CORE_SESSION_KEY;
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;
const AUTH_SESSION_KEY = { tag: 'AuthSession' as const };
const UNREACHABLE = new Error('protocol iframe never listened');
const CACHED_UI_STATE = JSON.stringify({ connected: true, liteUsername: 'pgherveou.04' });

/** Records this test's counts and reports, for the tests that read what the storage reports. */
function bindReports() {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  return { counted: metrics.counted, reports: recordReports({ onFinished: onTestFinished }) };
}

/** The sign-in window's core storage over `shared`, whose flag keeper owns the flag. */
function createWindowCoreStorage(flag: SessionPresence): HostCoreStorage {
  return createCoreStorage({
    shared,
    flag: createOwnerSignInFlag({ presence: flag, readStoredSignIn: readStoredInShared }),
  });
}

let shared: FakeSharedSessionStore;
let coreStorage: HostCoreStorage;
let presence: FakeSessionPresence;

/** What the fake shared store holds, as a page's flag keeper reads it. */
function readStoredInShared(): Promise<StoredSignIn> {
  return Promise.resolve(shared.entries.has(SESSION_KEY) ? 'held' : 'none');
}

describe('core storage', () => {
  beforeEach(() => {
    shared = createFakeSharedSessionStore();
    presence = createFakeSessionPresence({ state: 'present' });
    coreStorage = createCoreStorage({
      shared,
      flag: createNonOwnerSignInFlag({ presence, readStoredSignIn: readStoredInShared }),
    });
  });

  it('As a dotli integrator, I write, read and clear the host core session blob and it round-trips through the shared store', async () => {
    // Given
    const storage = coreStorage.createAdapters();

    // When
    const beforeWrite = await storage.readCoreStorage(AUTH_SESSION_KEY);
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    const readBack = await storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(beforeWrite).toBeUndefined();
    expect(shared.entries.get(SESSION_KEY)).toBe('0x010203');
    expect(Array.from(readBack ?? [])).toEqual([1, 2, 3]);

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);
    const afterClear = await storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(shared.entries.get(SESSION_KEY)).toBeUndefined();
    expect(afterClear).toBeUndefined();
  });

  it('As a dotli integrator, I read a corrupt shared auth session and get a cache miss', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    shared.entries.set(SESSION_KEY, 'not-hex');

    // When
    const stored = storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    await expect(stored).resolves.toBeUndefined();
  });

  it('As a returning user whose shared store times out, I open the page and my core reads no session instead of failing', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    shared.entries.set(SESSION_KEY, '0x010203');
    const timeout = new Error('Protocol request "authStorageRead" timed out after 30000ms');
    timeout.name = 'ProtocolTimeoutError';
    shared.readError = timeout;

    // When
    const stored = await storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(stored).toBeUndefined();
  });

  it('As a returning user whose shared store cannot be read, I open the page and the session read fails and is recorded once as an environment failure', async () => {
    // Given a shared store that cannot be reached
    const { counted, reports } = bindReports();
    shared.readError = UNREACHABLE;

    // When the session is read
    const session = await coreStorage.readSession();

    // Then the read answers failed, with one breadcrumb, no issue and one failed read counted
    expect(session).toEqual({ status: 'failed', error: UNREACHABLE });
    expect(reports.expected).toEqual([{ step: 'session_read', error: UNREACHABLE, tags: undefined }]);
    expect(reports.exceptions).toEqual([]);
    expect(counted('shared_session.read')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a dotli integrator, I read the session twice and session state hears whether each read failed', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    const reads: boolean[] = [];
    coreStorage.subscribeSessionReads(failed => {
      reads.push(failed);
    });
    shared.readError = UNREACHABLE;
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When
    shared.readError = null;
    await coreStorage.readSession();

    // Then
    expect(reads).toEqual([true, false]);
  });

  it('As a returning user whose shared store cannot be read, I open the page and the cached account reads as none and is reported once', async () => {
    // Given
    const { counted, reports } = bindReports();
    shared.readError = UNREACHABLE;

    // When
    const cached = await coreStorage.readUiCache();

    // Then
    expect(cached).toBeNull();
    expect(reports.expected).toEqual([{ step: 'ui_cache', error: UNREACHABLE, tags: undefined }]);
    expect(reports.exceptions).toEqual([]);
    expect(counted('shared_session.ui_cache')).toEqual([{ outcome: 'error', reason: 'read' }]);
  });

  it('As a signed-in user whose shared store refuses the cached account, I sign in and the write settles and is reported once', async () => {
    // Given
    const { counted, reports } = bindReports();
    shared.writeError = UNREACHABLE;

    // When
    const written = coreStorage.writeUiCache(CACHED_UI_STATE);

    // Then
    await expect(written).resolves.toBeUndefined();
    expect(reports.expected).toEqual([{ step: 'ui_cache', error: UNREACHABLE, tags: undefined }]);
    expect(counted('shared_session.ui_cache')).toEqual([{ outcome: 'error', reason: 'write' }]);
  });

  it('As a user whose shared store refuses the cached account clear, I log out and the session is still cleared while the failure is reported once', async () => {
    // Given
    const { counted, reports } = bindReports();
    const storage = coreStorage.createAdapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    shared.clearError = key => (key === UI_STATE_CACHE_KEY ? UNREACHABLE : null);

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(shared.entries.get(SESSION_KEY)).toBeUndefined();
    expect(reports.expected).toEqual([{ step: 'ui_cache', error: UNREACHABLE, tags: undefined }]);
    expect(counted('shared_session.ui_cache')).toEqual([{ outcome: 'error', reason: 'clear' }]);
  });

  it('As a dotli integrator, I listen for storage changes and hear local and matching changes until I unsubscribe', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    const listener = vi.fn();
    const unsubscribe = coreStorage.subscribeStoredSession(listener);

    // When the session is written here, another tab changes it and another key, and a write follows the unsubscribe
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9]));
    const afterTheWrite = listener.mock.calls.length;
    shared.changeFromOtherTab(SESSION_KEY, '0x09');
    shared.changeFromOtherTab(UI_STATE_CACHE_KEY, '{}');
    const afterTheOtherTab = listener.mock.calls.length;
    unsubscribe();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([8]));
    const afterTheUnsubscribe = listener.mock.calls.length;

    // Then the listener heard the write and the matching change, and nothing after the unsubscribe
    expect([afterTheWrite, afterTheOtherTab, afterTheUnsubscribe]).toEqual([1, 2, 2]);
  });

  it("As a user signing in through the window, I get the window's session installed with its account and my cores hear it", async () => {
    // Given a listener for session changes
    const listener = vi.fn();
    onTestFinished(coreStorage.subscribeStoredSession(listener));

    // When the window's session is installed with its account
    await coreStorage.installSession('0x0a0b', CACHED_UI_STATE);

    // Then the session and account are stored and the listener hears it once
    expect(shared.entries.get(SESSION_KEY)).toBe('0x0a0b');
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(CACHED_UI_STATE);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("As a user whose copy is the main store, I get the window's session installed and its account is cached so I see my name", async () => {
    // Given the window already stored the session, but no account
    shared.entries.set(SESSION_KEY, '0x0a0b');
    const listener = vi.fn();
    onTestFinished(coreStorage.subscribeStoredSession(listener));

    // When the window's session is installed with its account
    await coreStorage.installSession('0x0a0b', CACHED_UI_STATE);

    // Then the account is cached without a read and the listener hears it once
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(CACHED_UI_STATE);
    expect(shared.reads).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('As a user whose page already holds the session, I get it installed with no account and keep the account cached', async () => {
    // Given a copy already holding the session and its account
    shared.entries.set(SESSION_KEY, '0x0a0b');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);

    // When the session is installed with no account
    await coreStorage.installSession('0x0a0b', null);

    // Then the cached account stays
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(CACHED_UI_STATE);
  });

  it('As a returning user, I get the shared store back and my running cores are told to read the session again', () => {
    // Given
    const listener = vi.fn();
    const unsubscribe = coreStorage.subscribeStoredSession(listener);
    shared.setStatus('available');
    shared.setStatus('unavailable');

    // When
    shared.setStatus('available');

    // Then
    expect(listener).toHaveBeenCalledTimes(1);

    // When the listener unsubscribes
    unsubscribe();

    // Then
    expect(shared.statusListenerCount()).toBe(0);
  });

  it('As a local wallet user or a user in the sign-out window, I sign in and my core keeps its session in memory, away from the store and the cookie', async () => {
    // Given a session another tab stored, and no cookie yet
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    presence.state = 'absent';
    const storage = coreStorage.createAdapters({ sessionInMemory: true });

    // When the core restores, writes and clears its session in turn
    const read = await storage.readCoreStorage(AUTH_SESSION_KEY);
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9, 9]));
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(read).toBeUndefined();
    expect(shared.entries.get(SESSION_KEY)).toBe('0x010203');
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(CACHED_UI_STATE);
    expect(shared.reads).not.toContain(SESSION_KEY);
    expect(presence.calls).toEqual([]);
  });

  it('As a user dropping a dead session, I drop it after another tab stored a newer one and the newer session stays with its account', async () => {
    // Given my read of the dead session, then another tab's sign-in
    shared.entries.set(SESSION_KEY, '0x010203');
    const read = await coreStorage.readSession();
    shared.changeFromOtherTab(SESSION_KEY, '0x0a0b');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    const listener = vi.fn();
    onTestFinished(coreStorage.subscribeStoredSession(listener));

    // When the session read earlier is dropped
    const dropped = await coreStorage.dropSessionIf(
      must(read.status === 'ok' ? read.blob : null, 'the stored session'),
    );

    // Then nothing is dropped and the newer session and account stay
    expect(dropped).toBe(false);
    expect(shared.entries.get(SESSION_KEY)).toBe('0x0a0b');
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(CACHED_UI_STATE);
    expect(shared.clears).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('As a user in the sign-in window on a flag store that answers late, I pair and my session write waits for the flag', async () => {
    // Given a flag write still in flight, such as a request to the dev store
    const landed = createDeferred<undefined>();
    const asked = createDeferred<undefined>();
    const slow: SessionPresence = {
      read: () => Promise.resolve('absent'),
      set() {
        asked.resolve(undefined);
        return landed.promise;
      },
      clear: () => Promise.resolve(),
      renew: () => Promise.resolve(),
    };
    const storage = createWindowCoreStorage(slow).createAdapters();

    // When the core writes its session and the flag is asked
    const writing = storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    await asked.promise;

    // Then nothing is stored until the flag landed
    expect(shared.writes).toEqual([]);

    // When the flag write lands
    landed.resolve(undefined);
    await writing;

    // Then the session is written
    expect(shared.entries.get(SESSION_KEY)).toBe('0x010203');
  });

  it('As a user dropping a dead session, I drop the session I read and it goes with its account while my cores hear it', async () => {
    // Given a stored session with its account and a listener for session changes
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    const changed = vi.fn();
    onTestFinished(coreStorage.subscribeStoredSession(changed));

    // When the page drops the session it read
    const dropped = await coreStorage.dropSessionIf('0x010203');

    // Then both go, the flag is not touched and the listener hears it once
    expect(dropped).toBe(true);
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
    expect(shared.entries.has(UI_STATE_CACHE_KEY)).toBe(false);
    expect(presence.calls).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('As a user whose core drops the session it read, I let it clear and lose the session with its account and the cookie', async () => {
    // Given a stored session with its account that the core read
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    const storage = coreStorage.createAdapters();
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When the core clears it
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then both go and the cookie is deleted
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
    expect(shared.entries.has(UI_STATE_CACHE_KEY)).toBe(false);
    expect(presence.calls).toContain('clear');
  });

  it('As a user whose core drops its session after another tab signed in, I let it clear and keep the new sign-in and its cookie', async () => {
    // Given my core holding the session it read, then another tab's sign-in, which set the cookie first
    shared.entries.set(SESSION_KEY, '0x010203');
    const storage = coreStorage.createAdapters();
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    shared.changeFromOtherTab(SESSION_KEY, '0x0a0b');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);

    // When the core clears its old session
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the new session, its account and the cookie stay
    expect(shared.entries.get(SESSION_KEY)).toBe('0x0a0b');
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(CACHED_UI_STATE);
    expect(presence.calls).not.toContain('clear');
  });

  it('As a user whose core holds no session, I let it clear and a session another core stored is left alone', async () => {
    // Given a core that read an empty store, then a session stored by another core
    const storage = coreStorage.createAdapters();
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    shared.entries.set(SESSION_KEY, '0x0a0b');

    // When the core clears
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the other session stays and nothing was cleared
    expect(shared.entries.get(SESSION_KEY)).toBe('0x0a0b');
    expect(shared.clears).toEqual([]);
    expect(presence.calls).toEqual([]);
  });
});
