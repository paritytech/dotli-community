// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { SHARED_CORE_SESSION_KEY } from '@dotli/protocol';
import type { CoreStorageKey } from '@parity/truapi-host';
import { createCoreStorage, type HostCoreStorage } from './createCoreStorage.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createFakeSharedSessionStore, type FakeSharedSessionStore } from './createCoreStorage.fake.js';
import { createDeferred } from '@dotli/shared';
import { createMemoryStorage, must } from '@dotli/shared/testing';
import { createFakeSessionPresence, getUnservedChannel, type FakeSessionPresence } from './createPagePresence.fake.js';
import { createPagePresence } from './createPagePresence.js';
import type { SessionPresence } from './types.js';
import { createNonOwnerSignInFlag, createOwnerSignInFlag, type StoredSignIn } from './signInFlag.js';

const SESSION_KEY = SHARED_CORE_SESSION_KEY;
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;
const AUTH_SESSION_KEY = { tag: 'AuthSession' as const };
const UNREACHABLE = new Error('protocol iframe never listened');
const CACHED_UI_STATE = JSON.stringify({ connected: true, liteUsername: 'pgherveou.04' });

/**
 * A core storage over the given store, with a fake Sentry and capture sink bound for this test, for the tests that read
 * what it reports.
 */
function createReportingCoreStorage(shared: FakeSharedSessionStore, flag: SessionPresence = presence) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  return {
    counts: metrics.counts,
    counted: metrics.counted,
    captures,
    coreStorage: createCoreStorage({
      shared,
      flag: createNonOwnerSignInFlag({ presence: flag, readStoredSignIn: readStoredInShared }),
      local: () => local,
      keyDb: () => keyDb,
    }),
  };
}

/** The sign-in window's core storage over `shared`, beside a main store that holds a local wallet or not. */
function createWindowCoreStorage(flag: SessionPresence, wallet = false): HostCoreStorage {
  return createCoreStorage({
    shared,
    flag: createOwnerSignInFlag({
      presence: flag,
      readStoredSignIn: () => Promise.resolve(wallet || shared.entries.has(SESSION_KEY) ? 'held' : 'none'),
    }),
    local: () => local,
    keyDb: () => keyDb,
  });
}

let shared: FakeSharedSessionStore;
let coreStorage: HostCoreStorage;
let local: Storage;
let keyDb: IDBFactory;
let presence: FakeSessionPresence;

/** What the fake shared store holds, as a page's flag keeper reads it. */
function readStoredInShared(): Promise<StoredSignIn> {
  return Promise.resolve(shared.entries.has(SESSION_KEY) ? 'held' : 'none');
}

describe('core storage', () => {
  beforeEach(() => {
    local = createMemoryStorage();
    keyDb = new IDBFactory();
    shared = createFakeSharedSessionStore();
    presence = createFakeSessionPresence('present');
    coreStorage = createCoreStorage({
      shared,
      flag: createNonOwnerSignInFlag({ presence, readStoredSignIn: readStoredInShared }),
      local: () => local,
      keyDb: () => keyDb,
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
    expect(local.length).toBe(0);
    expect(Array.from(readBack ?? [])).toEqual([1, 2, 3]);

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);
    const afterClear = await storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(shared.entries.get(SESSION_KEY)).toBeUndefined();
    expect(afterClear).toBeUndefined();
  });

  it.each<{
    label: string;
    key: CoreStorageKey;
    bytes: number[];
    slot: RegExp;
    hidden: string[];
    stored: unknown;
  }>([
    {
      label: 'a permission authorization from a typed core key, and it round-trips through an opaque slot',
      key: {
        tag: 'PermissionAuthorization',
        value: {
          productId: 'My App',
          request: { tag: 'Device', value: 'OpenUrl' },
        },
      },
      bytes: [4],
      slot: /^dotli:core:permission:[0-9a-f]+$/,
      hidden: ['open-url'],
      stored: '0x04',
    },
    {
      label: 'a remote permission authorization, and its key stays opaque',
      key: {
        tag: 'PermissionAuthorization',
        value: {
          productId: 'myapp',
          request: {
            tag: 'Remote',
            value: {
              permission: {
                tag: 'Remote',
                value: { domains: ['B.example', 'a.example', 'b.example'] },
              },
            },
          },
        },
      },
      bytes: [7],
      slot: /^dotli:core:permission:[0-9a-f]+$/,
      hidden: ['example'],
      stored: expect.any(String),
    },
    {
      label: 'allowance keys, and they are stored encrypted and read back',
      key: { tag: 'AllowanceKeys', value: { sessionId: 'session-1' } },
      bytes: [1, 2, 3, 4],
      slot: /^dotli:core:allowance-keys:session-1$/,
      hidden: [],
      stored: expect.not.stringMatching(/^0x01020304$/),
    },
    {
      label: 'a product auto-signing key, and it is stored encrypted in an opaque slot',
      key: { tag: 'AutoSigningKey', value: { productId: 'truapi-playground.dot' } },
      bytes: [5, 6, 7, 8],
      slot: /^dotli:core:auto-signing:[0-9a-f]+$/,
      hidden: ['truapi-playground.dot'],
      stored: expect.stringMatching(/^enc1:0x/),
    },
    {
      label: 'the device encryption secret, and it is stored encrypted in a stable install-wide slot',
      key: { tag: 'DeviceEncryptionKey' },
      bytes: [9, 10, 11, 12],
      // Peers address this device by the public counterpart, so the slot name
      // must not move with the session: a fresh name would orphan them.
      slot: /^dotli:core:device-encryption-key$/,
      hidden: [],
      stored: expect.stringMatching(/^enc1:0x/),
    },
  ])('As a dotli integrator, I write $label', async ({ key, bytes, slot, hidden, stored }) => {
    // Given
    const storage = coreStorage.createAdapters();

    // When
    await storage.writeCoreStorage(key, new Uint8Array(bytes));
    const readBack = await storage.readCoreStorage(key);

    // Then
    expect(local.length).toBe(1);
    const storageKey = local.key(0);
    expect(storageKey).toMatch(slot);
    expect(hidden.filter(label => storageKey?.includes(label) === true)).toEqual([]);
    expect(local.getItem(storageKey ?? '')).toEqual(stored);
    expect(Array.from(readBack ?? [])).toEqual(bytes);

    // When
    await storage.clearCoreStorage(key);
    const afterClear = await storage.readCoreStorage(key);

    // Then
    expect(afterClear).toBeUndefined();
  });

  it('As a dotli integrator, I write product subtree keys for two sessions and each is stored per session in an opaque plaintext slot', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    const key = {
      tag: 'ProductSubtree',
      value: {
        sessionId: 'session-1',
        productId: 'truapi-playground.dot',
      },
    } satisfies CoreStorageKey;
    const otherSession = {
      tag: 'ProductSubtree',
      value: {
        sessionId: 'session-2',
        productId: 'truapi-playground.dot',
      },
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([13]));
    await storage.writeCoreStorage(otherSession, new Uint8Array([14]));
    const readBack = await storage.readCoreStorage(key);
    const otherReadBack = await storage.readCoreStorage(otherSession);

    // Then
    // The slot holds a public key, so it is stored in the clear, but the
    // product it belongs to stays out of the visible storage key.
    expect(local.length).toBe(2);
    for (const index of [0, 1]) {
      const storageKey = local.key(index);
      expect(storageKey).toMatch(/^dotli:core:product-subtree:[0-9a-f]+$/);
      expect(storageKey).not.toContain('truapi-playground.dot');
      expect(local.getItem(storageKey ?? '')).toMatch(/^0x/);
    }
    // Pairing again answers afresh, so one session's answer must not be read
    // back for another.
    expect(Array.from(readBack ?? [])).toEqual([13]);
    expect(Array.from(otherReadBack ?? [])).toEqual([14]);

    // When
    await storage.clearCoreStorage(key);
    const afterClear = await storage.readCoreStorage(key);
    const otherAfterClear = await storage.readCoreStorage(otherSession);

    // Then
    expect(afterClear).toBeUndefined();
    expect(Array.from(otherAfterClear ?? [])).toEqual([14]);
  });

  it('As a dotli integrator, I write the SSO responder replay ledger for two peers and each peer gets its own slot', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    const key = {
      tag: 'SsoResponderRequestLedger',
      value: {
        rootPublicKey: new Uint8Array(32).fill(1),
        peerStatementAccountId: new Uint8Array(32).fill(2),
        peerEncryptionPublicKey: new Uint8Array(32).fill(3),
      },
    } satisfies CoreStorageKey;
    const otherPeer = {
      tag: 'SsoResponderRequestLedger',
      value: {
        rootPublicKey: new Uint8Array(32).fill(1),
        peerStatementAccountId: new Uint8Array(32).fill(2),
        peerEncryptionPublicKey: new Uint8Array(32).fill(4),
      },
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([21]));
    await storage.writeCoreStorage(otherPeer, new Uint8Array([22]));
    const readBack = await storage.readCoreStorage(key);
    const otherReadBack = await storage.readCoreStorage(otherPeer);

    // Then
    // Core-owned replay state, not key material, so it is stored like the
    // ring registry snapshot rather than under at-rest encryption.
    expect(local.length).toBe(2);
    for (const index of [0, 1]) {
      const storageKey = local.key(index);
      expect(storageKey).toMatch(/^dotli:core:sso-responder-ledger:[0-9a-f]+$/);
      expect(local.getItem(storageKey ?? '')).toMatch(/^0x/);
    }
    // The ledger bounds replays for one peer, so two peers of the same wallet
    // must never share a slot.
    expect(Array.from(readBack ?? [])).toEqual([21]);
    expect(Array.from(otherReadBack ?? [])).toEqual([22]);

    // When
    await storage.clearCoreStorage(key);
    const afterClear = await storage.readCoreStorage(key);
    const otherAfterClear = await storage.readCoreStorage(otherPeer);

    // Then
    expect(afterClear).toBeUndefined();
    expect(Array.from(otherAfterClear ?? [])).toEqual([22]);
  });

  it('As a dotli integrator, I write the same allowance keys twice and no nonce is reused', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:session-1';

    // When: the same plaintext is written twice
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const first = local.getItem(storageKey);
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const second = local.getItem(storageKey);
    const readBack = await storage.readCoreStorage(key);

    // Then: the ciphertexts differ (fresh nonce per write) and still decrypt
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(Array.from(readBack ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('As a dotli integrator, I write allowance keys and they are encrypted under a non-extractable per-install key', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const stored = await readStoredAllowanceKey(keyDb);
    const exported = crypto.subtle.exportKey('raw', must(stored, 'the stored key'));

    // Then: the encryption key is a random per-install CryptoKey persisted in IndexedDB whose material can never be
    // exported, not something derivable from public bundle data.
    expect(stored?.type).toBe('secret');
    expect(stored?.extractable).toBe(false);
    await expect(exported).rejects.toThrow();
  });

  it('As a dotli integrator, I read legacy plaintext allowance keys and they are migrated to encrypted slots', async () => {
    // Given: a plain-hex slot written before at-rest encryption shipped
    const storage = coreStorage.createAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'legacy' },
    } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:legacy';
    local.setItem(storageKey, '0x01020304');

    // When
    const bytes = await storage.readCoreStorage(key);
    const reread = await storage.readCoreStorage(key);

    // Then: the legacy bytes are readable and re-persisted encrypted
    expect(Array.from(bytes ?? [])).toEqual([1, 2, 3, 4]);
    expect(local.getItem(storageKey)).toMatch(/^enc1:0x/);
    expect(Array.from(reread ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('As a dotli integrator, I read an allowance slot that no longer decrypts and it is dropped instead of returning ciphertext', async () => {
    // Given: an encrypted slot whose ciphertext no longer authenticates, the
    // same shape as a key lost to an IndexedDB wipe or tampered bytes
    const storage = coreStorage.createAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:session-1';
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const stored = local.getItem(storageKey) ?? '';
    const flipped = stored.slice(0, -2) + (stored.endsWith('00') ? 'ff' : '00');
    local.setItem(storageKey, flipped);

    // When
    const bytes = await storage.readCoreStorage(key);

    // Then: a true cache miss. Ciphertext is never handed back as key
    // material, and the dead slot is removed rather than re-encrypted
    expect(bytes).toBeUndefined();
    expect(local.getItem(storageKey)).toBeNull();
  });

  it('As a dotli integrator, I read corrupt persisted core bytes and get a cache miss', async () => {
    // Given
    const { counted, captures, coreStorage: reporting } = createReportingCoreStorage(shared);
    const storage = reporting.createAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'corrupt' },
    } satisfies CoreStorageKey;
    local.setItem('dotli:core:allowance-keys:corrupt', 'not-hex');

    // When
    const stored = storage.readCoreStorage(key);

    // Then
    await expect(stored).resolves.toBeUndefined();
    expect(counted('core_storage.read')).toEqual([{ outcome: 'error', reason: 'corrupt' }]);
    expect(captures.expected.mock.calls).toEqual([[expect.anything(), { flow: 'storage', step: 'core_decode' }]]);
  });

  it('As a dotli integrator, I read a corrupt shared auth session and get a cache miss', async () => {
    // Given
    const { counted, captures, coreStorage: reporting } = createReportingCoreStorage(shared);
    const storage = reporting.createAdapters();
    shared.entries.set(SESSION_KEY, 'not-hex');

    // When
    const stored = storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    await expect(stored).resolves.toBeUndefined();
    expect(counted('core_storage.read')).toEqual([{ outcome: 'error', reason: 'corrupt' }]);
    expect(captures.expected.mock.calls).toEqual([[expect.anything(), { flow: 'storage', step: 'core_decode' }]]);
  });

  it('As an operator, I watch shared session reads and see each counted as a hit or a miss', async () => {
    // Given
    const { counts, coreStorage } = createReportingCoreStorage(shared);
    const storage = coreStorage.createAdapters();
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    shared.entries.set(SESSION_KEY, '0x010203');

    // When
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(counts.map(({ name, attributes }) => [name, attributes])).toEqual([
      ['dotli.shared_session.read', { outcome: 'miss' }],
      ['dotli.shared_session.read', { outcome: 'hit' }],
    ]);
  });

  it('As an operator, I watch a failed shared session read and see it counted with its error name', async () => {
    // Given
    const { counted, coreStorage } = createReportingCoreStorage(shared);
    const storage = coreStorage.createAdapters();
    shared.entries.set(SESSION_KEY, '0x010203');
    const timeout = new Error('Protocol request "authStorageRead" timed out after 30000ms');
    timeout.name = 'ProtocolTimeoutError';
    shared.readError = timeout;

    // When
    const stored = await storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(stored).toBeUndefined();
    expect(counted('shared_session.read')).toContainEqual({ outcome: 'error', reason: 'ProtocolTimeoutError' });
  });

  it('As a returning user whose shared store cannot be read, I open the page and the session read fails and is recorded once as an environment failure', async () => {
    // Given a shared store that cannot be reached
    const { counted, captures, coreStorage } = createReportingCoreStorage(shared);
    shared.readError = UNREACHABLE;

    // When the session is read
    const session = await coreStorage.readSession();

    // Then the read answers failed, with one breadcrumb, no issue and one failed read counted
    expect(session).toEqual({ status: 'failed', error: UNREACHABLE });
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(UNREACHABLE, { flow: 'storage', step: 'session_read' });
    expect(captures.exception).not.toHaveBeenCalled();
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

  it('As a dotli integrator, I clear the session and the cached UI state goes with it', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    await coreStorage.writeUiCache(JSON.stringify({ connected: true }));

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(shared.entries.get(SESSION_KEY)).toBeUndefined();
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it('As a returning user whose shared store cannot be read, I open the page and the cached account reads as none and is reported once', async () => {
    // Given
    const { counted, captures, coreStorage } = createReportingCoreStorage(shared);
    shared.readError = UNREACHABLE;

    // When
    const cached = await coreStorage.readUiCache();

    // Then
    expect(cached).toBeNull();
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(UNREACHABLE, { flow: 'storage', step: 'ui_cache' });
    expect(captures.exception).not.toHaveBeenCalled();
    expect(counted('shared_session.ui_cache')).toEqual([{ outcome: 'error', reason: 'read' }]);
  });

  it('As a signed-in user whose shared store refuses the cached account, I sign in and the write settles and is reported once', async () => {
    // Given
    const { counted, captures, coreStorage } = createReportingCoreStorage(shared);
    shared.writeError = UNREACHABLE;

    // When
    const written = coreStorage.writeUiCache(CACHED_UI_STATE);

    // Then
    await expect(written).resolves.toBeUndefined();
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(counted('shared_session.ui_cache')).toEqual([{ outcome: 'error', reason: 'write' }]);
  });

  it('As a user whose shared store refuses the cached account clear, I log out and the session is still cleared while the failure is reported once', async () => {
    // Given
    const { counted, captures, coreStorage } = createReportingCoreStorage(shared);
    const storage = coreStorage.createAdapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    shared.clearError = key => (key === UI_STATE_CACHE_KEY ? UNREACHABLE : null);

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(shared.entries.get(SESSION_KEY)).toBeUndefined();
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(UNREACHABLE, { flow: 'storage', step: 'ui_cache' });
    expect(counted('shared_session.ui_cache')).toEqual([{ outcome: 'error', reason: 'clear' }]);
  });

  it('As a dotli integrator, I listen for storage changes and hear local and matching changes until I unsubscribe', async () => {
    // Given
    const storage = coreStorage.createAdapters();
    const listener = vi.fn();
    const unsubscribe = coreStorage.onStoredSessionChanged(listener);

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
    onTestFinished(coreStorage.onStoredSessionChanged(listener));

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
    onTestFinished(coreStorage.onStoredSessionChanged(listener));

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
    const unsubscribe = coreStorage.onStoredSessionChanged(listener);
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
    onTestFinished(coreStorage.onStoredSessionChanged(listener));

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

  it('As a dotli integrator, I add a second storage listener and it still hears a change when the first throws', async () => {
    // Given a first listener that throws and a second that counts
    onTestFinished(bindCaptureSink({ exception: vi.fn(), expected: vi.fn() }));
    const heard = vi.fn();
    onTestFinished(
      coreStorage.onStoredSessionChanged(() => {
        throw new Error('first listener broke');
      }),
    );
    onTestFinished(coreStorage.onStoredSessionChanged(heard));

    // When the session is written
    await coreStorage.createAdapters().writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1]));

    // Then the write succeeded and the second listener heard it
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('As an operator, I see a browser that cannot keep the at-rest key recorded once and the session still round-trips its secrets', async () => {
    // Given a key store the browser refuses
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const storage = createCoreStorage({
      shared,
      flag: createNonOwnerSignInFlag({ presence, readStoredSignIn: readStoredInShared }),
      local: () => local,
      keyDb() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    }).createAdapters();
    const key = { tag: 'AllowanceKeys', value: { sessionId: 'session-1' } } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const readBack = await storage.readCoreStorage(key);

    // Then
    expect(Array.from(readBack ?? [])).toEqual([1, 2, 3, 4]);
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(expect.any(DOMException), {
      flow: 'storage',
      step: 'core_secret_key',
    });
    expect(metrics.counted('core_storage.secret')).toEqual([{ outcome: 'error', reason: 'ephemeral_key' }]);
  });

  it('As an operator, I see a secret slot that no longer decrypts recorded and counted as it is dropped', async () => {
    // Given an encrypted slot whose ciphertext no longer authenticates
    const { counted, captures, coreStorage: reporting } = createReportingCoreStorage(shared);
    const storage = reporting.createAdapters();
    const key = { tag: 'AllowanceKeys', value: { sessionId: 'session-1' } } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:session-1';
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const stored = local.getItem(storageKey) ?? '';
    local.setItem(storageKey, stored.slice(0, -2) + (stored.endsWith('00') ? 'ff' : '00'));

    // When
    await storage.readCoreStorage(key);

    // Then
    expect(captures.expected).toHaveBeenCalledWith(expect.anything(), { flow: 'storage', step: 'core_secret_decrypt' });
    expect(counted('core_storage.secret')).toEqual([{ outcome: 'error', reason: 'undecryptable' }]);
  });

  it('As a user whose core drops its session, I lose the session and the cookie is deleted', async () => {
    // Given a core that wrote its session
    const storage = coreStorage.createAdapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // When the core clears it
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the cookie is deleted
    expect(presence.calls).toContain('clear');
    expect(presence.state).toBe('absent');
  });

  it('As a user in the sign-in window, I pair and my core sets the cookie before its session write lands', async () => {
    // Given a window's core over an absent flag, recording the writes when it is set
    presence.state = 'absent';
    const storage = createWindowCoreStorage(presence).createAdapters();
    const writesWhenSet: number[] = [];
    const set = presence.set.bind(presence);
    presence.set = recordSet;

    // When the core writes its session
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // Then the flag went up while nothing was stored yet, and again once the session landed
    expect(writesWhenSet).toEqual([0, 1]);
    expect(presence.state).toBe('present');
    expect(shared.entries.get(SESSION_KEY)).toBe('0x010203');

    function recordSet(): Promise<void> {
      writesWhenSet.push(shared.writes.length);
      return set();
    }
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

  it('As a user on a product page, I let my core rewrite its session and the cookie is never set', async () => {
    // Given a product page's core over an absent flag
    presence.state = 'absent';
    const storage = coreStorage.createAdapters();

    // When the core writes its session
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // Then the flag is never set
    expect(presence.calls).not.toContain('set');
    expect(presence.state).toBe('absent');
  });

  it('As a local wallet user, I let my core clear its session and the cookie is left alone', async () => {
    // Given a core whose session lives in memory
    const storage = coreStorage.createAdapters({ sessionInMemory: true });

    // When the core clears its session
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the cookie is not touched
    expect(presence.calls).not.toContain('clear');
  });

  it('As a user dropping a dead session, I drop the session I read and it goes with its account while my cores hear it', async () => {
    // Given a stored session with its account and a listener for session changes
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    const changed = vi.fn();
    onTestFinished(coreStorage.onStoredSessionChanged(changed));

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

  it("As a user whose store refuses my core's clear, I let my core clear and the cookie is still deleted so every page drops it on load", async () => {
    // Given a core session whose clear the store refuses
    onTestFinished(bindCaptureSink({ exception: vi.fn(), expected: vi.fn() }));
    const storage = coreStorage.createAdapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    shared.clearError = key => (key === SESSION_KEY ? UNREACHABLE : null);

    // When the core clears it
    const cleared = storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the clear rejects and the cookie is still deleted
    await expect(cleared).rejects.toBe(UNREACHABLE);
    expect(presence.calls).toContain('clear');
  });

  it('As a user whose core drops its session while the flag stays, I let it clear and the session still goes', async () => {
    // Given a core session whose flag cannot be cleared
    const failure = new Error('cookie blocked');
    const unwritable = createPagePresence({
      isShared: () => true,
      localhost: false,
      channel: getUnservedChannel,
      jar: {
        read: () => '',
        write() {
          throw failure;
        },
      },
    });
    const { counted, captures, coreStorage: reporting } = createReportingCoreStorage(shared, unwritable);
    const storage = reporting.createAdapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // When the core clears it
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the session goes and the flag failure is reported
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'presence_clear',
      tags: { reason: 'clear' },
    });
    expect(counted('session.flag_write')).toEqual([{ outcome: 'error', reason: 'clear' }]);
  });

  it('As a user in the sign-in window whose core drops its session while a wallet stays stored, I let it clear and keep the cookie for the wallet', async () => {
    // Given a window's core session beside a stored wallet
    const storage = createWindowCoreStorage(presence, true).createAdapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // When the core clears it
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the session goes and the flag stays for the wallet
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
    expect(presence.calls).not.toContain('clear');
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window whose core drops the last sign-in stored, I let it clear and lose the cookie with it', async () => {
    // Given a window's core session that is the last sign-in stored
    const storage = createWindowCoreStorage(presence).createAdapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // When the core clears it
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the session goes and the flag drops
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
    expect(presence.state).toBe('absent');
  });
});

/** The at-rest key the core storage keeps for allowance keys in its IndexedDB key store. */
async function readStoredAllowanceKey(factory: IDBFactory): Promise<CryptoKey | undefined> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('dotli-core');
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('opening dotli-core failed'));
    };
  });
  try {
    return await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const request = database.transaction('keys').objectStore('keys').get('allowance-keys');
      request.onsuccess = () => {
        // IndexedDB types a stored value as any, and this store holds only CryptoKey values.
        resolve(request.result as CryptoKey | undefined);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('reading allowance-keys failed'));
      };
    });
  } finally {
    database.close();
  }
}
