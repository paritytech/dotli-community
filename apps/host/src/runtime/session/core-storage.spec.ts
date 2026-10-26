// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { SHARED_CORE_SESSION_KEY } from '@dotli/protocol';
import type { CoreStorageKey } from '@parity/truapi-host';
import { createCoreStorage, type HostCoreStorage } from './core-storage.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createFakeSharedSessionStore, type FakeSharedSessionStore } from './core-storage.fake.js';
import { deferred } from '@dotli/shared';
import { memoryStorage, must } from '@dotli/shared/testing';
import { createFakeSessionPresence, type FakeSessionPresence } from './presence.fake.js';
import { createPagePresence, type SessionPresence } from './presence.js';
import { pageSignInFlag, ownerSignInFlag, type StoredSignIn } from './sign-in-flag.js';

const SESSION_KEY = SHARED_CORE_SESSION_KEY;
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;
const AUTH_SESSION_KEY = { tag: 'AuthSession' as const };
const UNREACHABLE = new Error('protocol iframe never listened');
const CACHED_UI_STATE = JSON.stringify({ connected: true, liteUsername: 'pgherveou.04' });

/** A core storage over the given store, with a fake Sentry and capture sink bound for this test, for the tests that read what it reports. */
function loadWithMetrics(shared: FakeSharedSessionStore, flag: SessionPresence = presence) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  return {
    counts: metrics.counts,
    counted: metrics.counted,
    captures,
    coreStorage: createCoreStorage({
      shared,
      flag: pageSignInFlag({ presence: flag, storedSignIn: storedInShared }),
      local: () => local,
      keyDb: () => keyDb,
    }),
  };
}

/** The sign-in window's core storage over `shared`, beside a main store that holds a local wallet or not. */
function windowCoreStorage(flag: SessionPresence, wallet = false): HostCoreStorage {
  return createCoreStorage({
    shared,
    flag: ownerSignInFlag({
      presence: flag,
      storedSignIn: () => Promise.resolve(wallet || shared.entries.has(SESSION_KEY) ? 'held' : 'none'),
    }),
    local: () => local,
    keyDb: () => keyDb,
  });
}

let shared: FakeSharedSessionStore;

/** What the fake shared store holds, as a page's flag keeper reads it. */
const storedInShared = (): Promise<StoredSignIn> => Promise.resolve(shared.entries.has(SESSION_KEY) ? 'held' : 'none');
let coreStorage: HostCoreStorage;
let local: Storage;
let keyDb: IDBFactory;
let presence: FakeSessionPresence;

describe('core storage', () => {
  beforeEach(() => {
    local = memoryStorage();
    keyDb = new IDBFactory();
    shared = createFakeSharedSessionStore();
    presence = createFakeSessionPresence('present');
    coreStorage = createCoreStorage({
      shared,
      flag: pageSignInFlag({ presence, storedSignIn: storedInShared }),
      local: () => local,
      keyDb: () => keyDb,
    });
  });

  it('As a dotli integrator, the host round-trips the host core session blob', async () => {
    // Given
    const storage = coreStorage.adapters();

    expect(await storage.readCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();

    // When
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // Then
    expect(shared.entries.get(SESSION_KEY)).toBe('0x010203');
    expect(local.length).toBe(0);
    expect(Array.from((await storage.readCoreStorage(AUTH_SESSION_KEY)) ?? [])).toEqual([1, 2, 3]);

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(shared.entries.get(SESSION_KEY)).toBeUndefined();
    expect(await storage.readCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();
  });

  it('As a dotli integrator, the host round-trips permission authorization slots from typed core keys', async () => {
    // Given
    const storage = coreStorage.adapters();
    const key = {
      tag: 'PermissionAuthorization',
      value: {
        productId: 'My App',
        request: { tag: 'Device', value: 'OpenUrl' },
      },
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([4]));

    // Then
    expect(local.length).toBe(1);
    const storageKey = local.key(0);
    expect(storageKey).toMatch(/^dotli:core:permission:[0-9a-f]+$/);
    expect(storageKey).not.toContain('open-url');
    expect(local.getItem(storageKey ?? '')).toBe('0x04');
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([4]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
  });

  it('As a dotli integrator, the host keeps remote permission authorization keys opaque', async () => {
    // Given
    const storage = coreStorage.adapters();
    const key = {
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
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([7]));

    // Then
    const storageKey = local.key(0);
    expect(storageKey).toMatch(/^dotli:core:permission:[0-9a-f]+$/);
    expect(storageKey).not.toContain('example');
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([7]);
    expect(local.length).toBe(1);
  });

  it('As a dotli integrator, the host encrypts persisted allowance key slots', async () => {
    // Given
    const storage = coreStorage.adapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));

    // Then
    const storageKey = 'dotli:core:allowance-keys:session-1';
    expect(local.getItem(storageKey)).not.toBe('0x01020304');
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([1, 2, 3, 4]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
  });

  it('As a dotli integrator, the host encrypts product auto-signing keys in opaque slots', async () => {
    // Given
    const storage = coreStorage.adapters();
    const key = {
      tag: 'AutoSigningKey',
      value: { productId: 'truapi-playground.dot' },
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([5, 6, 7, 8]));

    // Then
    expect(local.length).toBe(1);
    const storageKey = local.key(0);
    expect(storageKey).toMatch(/^dotli:core:auto-signing:[0-9a-f]+$/);
    expect(storageKey).not.toContain('truapi-playground.dot');
    expect(local.getItem(storageKey ?? '')).toMatch(/^enc1:0x/);
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([5, 6, 7, 8]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
  });

  it('As a dotli integrator, the host encrypts the device encryption secret in a stable install-wide slot', async () => {
    // Given
    const storage = coreStorage.adapters();
    const key = { tag: 'DeviceEncryptionKey' } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([9, 10, 11, 12]));

    // Then
    // Peers address this device by the public counterpart, so the slot name
    // must not move with the session: a fresh name would orphan them.
    const storageKey = 'dotli:core:device-encryption-key';
    expect(local.getItem(storageKey)).toMatch(/^enc1:0x/);
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([9, 10, 11, 12]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
  });

  it('As a dotli integrator, the host stores product subtree keys per session in opaque plaintext slots', async () => {
    // Given
    const storage = coreStorage.adapters();
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
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([13]);
    expect(Array.from((await storage.readCoreStorage(otherSession)) ?? [])).toEqual([14]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
    expect(Array.from((await storage.readCoreStorage(otherSession)) ?? [])).toEqual([14]);
  });

  it('As a dotli integrator, the host stores the SSO responder replay ledger per wallet and peer', async () => {
    // Given
    const storage = coreStorage.adapters();
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
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([21]);
    expect(Array.from((await storage.readCoreStorage(otherPeer)) ?? [])).toEqual([22]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
    expect(Array.from((await storage.readCoreStorage(otherPeer)) ?? [])).toEqual([22]);
  });

  it('As a dotli integrator, the host never reuses a nonce across allowance key writes', async () => {
    // Given
    const storage = coreStorage.adapters();
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

    // Then: the ciphertexts differ (fresh nonce per write) and still decrypt
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('As a dotli integrator, the host encrypts allowance keys under a non-extractable per-install key', async () => {
    // Given
    const storage = coreStorage.adapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));

    // Then: the encryption key is a random per-install CryptoKey persisted
    // in IndexedDB whose material can never be exported, not something
    // derivable from public bundle data.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = keyDb.open('dotli-core');
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('opening dotli-core failed'));
      };
    });
    const stored = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get('allowance-keys');
      request.onsuccess = () => {
        resolve(request.result as CryptoKey);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('reading allowance-keys failed'));
      };
    });
    db.close();
    expect(stored?.type).toBe('secret');
    expect(stored?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', must(stored, 'the stored key'))).rejects.toThrow();
  });

  it('As a dotli integrator, the host migrates legacy plaintext allowance keys on read', async () => {
    // Given: a plain-hex slot written before at-rest encryption shipped
    const storage = coreStorage.adapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'legacy' },
    } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:legacy';
    local.setItem(storageKey, '0x01020304');

    // When
    const bytes = await storage.readCoreStorage(key);

    // Then: the legacy bytes are readable and re-persisted encrypted
    expect(Array.from(bytes ?? [])).toEqual([1, 2, 3, 4]);
    expect(local.getItem(storageKey)).toMatch(/^enc1:0x/);
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('As a dotli integrator, the host drops allowance slots that no longer decrypt instead of returning ciphertext', async () => {
    // Given: an encrypted slot whose ciphertext no longer authenticates, the
    // same shape as a key lost to an IndexedDB wipe or tampered bytes
    const storage = coreStorage.adapters();
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

  it('As a dotli integrator, the host treats corrupt persisted core bytes as a cache miss', async () => {
    // Given
    const storage = coreStorage.adapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'corrupt' },
    } satisfies CoreStorageKey;
    local.setItem('dotli:core:allowance-keys:corrupt', 'not-hex');

    // When
    const stored = storage.readCoreStorage(key);

    // Then
    await expect(stored).resolves.toBeUndefined();
  });

  it('As a dotli integrator, the host treats a corrupt shared auth session as a cache miss', async () => {
    // Given
    const storage = coreStorage.adapters();
    shared.entries.set(SESSION_KEY, 'not-hex');

    // When
    const stored = storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    await expect(stored).resolves.toBeUndefined();
  });

  it('As an operator, I see each shared session read counted as a hit or a miss', async () => {
    // Given
    const { counts, coreStorage } = loadWithMetrics(shared);
    const storage = coreStorage.adapters();
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

  it('As an operator, I see a failed shared session read counted with its error name', async () => {
    // Given
    const { counted, coreStorage } = loadWithMetrics(shared);
    const storage = coreStorage.adapters();
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

  it('As a returning user whose shared store cannot be read, the session read is recorded once as an environment failure and reads as failed', async () => {
    // Given a shared store that cannot be reached
    const { counted, captures, coreStorage } = loadWithMetrics(shared);
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

  it('As a dotli integrator, the host tells session state whether each session read failed', async () => {
    // Given
    const storage = coreStorage.adapters();
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

  it('As a dotli integrator, the host clears the cached UI state with the session', async () => {
    // Given
    const storage = coreStorage.adapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    await coreStorage.writeUiCache(JSON.stringify({ connected: true }));

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(shared.entries.get(SESSION_KEY)).toBeUndefined();
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it('As a returning user whose shared store cannot be read, the cached account read is reported once and reads as none', async () => {
    // Given
    const { counted, captures, coreStorage } = loadWithMetrics(shared);
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

  it('As a signed-in user whose shared store refuses the cached account, the write is reported once and settles', async () => {
    // Given
    const { counted, captures, coreStorage } = loadWithMetrics(shared);
    shared.writeError = UNREACHABLE;

    // When
    const written = coreStorage.writeUiCache(CACHED_UI_STATE);

    // Then
    await expect(written).resolves.toBeUndefined();
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(counted('shared_session.ui_cache')).toEqual([{ outcome: 'error', reason: 'write' }]);
  });

  it('As a user who logs out while the shared store refuses the cached account clear, the session is still cleared and the failure is reported once', async () => {
    // Given
    const { counted, captures, coreStorage } = loadWithMetrics(shared);
    const storage = coreStorage.adapters();
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

  it('As a dotli integrator, the host notifies local and matching storage changes', async () => {
    // Given
    const storage = coreStorage.adapters();
    const listener = vi.fn();
    const unsubscribe = coreStorage.onStoredSessionChanged(listener);

    // When
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9]));

    // Then
    expect(listener).toHaveBeenCalledTimes(1);

    // When
    shared.changeFromOtherTab(SESSION_KEY, '0x09');
    shared.changeFromOtherTab(UI_STATE_CACHE_KEY, '{}');

    // Then
    expect(listener).toHaveBeenCalledTimes(2);

    // When
    unsubscribe();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([8]));

    // Then
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('As a page, I install a session from the sign-in window with its account and my cores hear it', async () => {
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

  it("As a page whose copy is the main store, I install the window's session and cache its account so I show my name", async () => {
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

  it('As a page that already holds the session, I install it with no account and keep the account I cached', async () => {
    // Given a copy already holding the session and its account
    shared.entries.set(SESSION_KEY, '0x0a0b');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);

    // When the session is installed with no account
    await coreStorage.installSession('0x0a0b', null);

    // Then the cached account stays
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(CACHED_UI_STATE);
  });

  it('As a returning user whose shared store comes back, my running cores are told to read the session again', () => {
    // Given
    const listener = vi.fn();
    const unsubscribe = coreStorage.onStoredSessionChanged(listener);
    shared.setStatus('available');
    shared.setStatus('unavailable');
    expect(listener).not.toHaveBeenCalled();

    // When
    shared.setStatus('available');

    // Then
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(shared.statusListenerCount()).toBe(0);
  });

  it('As a local wallet user or a user in the sign-out window, I sign in and my core keeps its session in memory, away from the store and the cookie', async () => {
    // Given a session another tab stored, and no cookie yet
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    presence.state = 'absent';
    const storage = coreStorage.adapters({ sessionInMemory: true });

    // When the core restores, writes and then clears its session
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

  it('As a page dropping a dead session, I keep a session another tab stores after my read with its account', async () => {
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

  it("As a second listener of the core's storage, I still hear a change when the first listener throws", async () => {
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
    await coreStorage.adapters().writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1]));

    // Then the write succeeded and the second listener heard it
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('As an operator, a browser that cannot keep the at-rest key is recorded once, and this session still round-trips its secrets', async () => {
    // Given a key store the browser refuses
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const storage = createCoreStorage({
      shared,
      flag: pageSignInFlag({ presence, storedSignIn: storedInShared }),
      local: () => local,
      keyDb: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    }).adapters();
    const key = { tag: 'AllowanceKeys', value: { sessionId: 'session-1' } } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));

    // Then
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([1, 2, 3, 4]);
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(expect.any(DOMException), {
      flow: 'storage',
      step: 'core_secret_key',
    });
    expect(metrics.counted('core_storage.secret')).toEqual([{ outcome: 'error', reason: 'ephemeral_key' }]);
  });

  it('As an operator, a secret slot that no longer decrypts is recorded and counted as it is dropped', async () => {
    // Given an encrypted slot whose ciphertext no longer authenticates
    const { counted, captures, coreStorage: reporting } = loadWithMetrics(shared);
    const storage = reporting.adapters();
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

  it('As a page whose core drops its session, I delete the cookie', async () => {
    // Given a core that wrote its session
    const storage = coreStorage.adapters();
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
    const storage = windowCoreStorage(presence).adapters();
    const writesWhenSet: number[] = [];
    const set = presence.set.bind(presence);
    presence.set = () => {
      writesWhenSet.push(shared.writes.length);
      return set();
    };

    // When the core writes its session
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // Then the flag went up while nothing was stored yet, and again once the session landed
    expect(writesWhenSet).toEqual([0, 1]);
    expect(presence.state).toBe('present');
    expect(shared.entries.get(SESSION_KEY)).toBe('0x010203');
  });

  it('As a user in the sign-in window on a flag store that answers late, I pair and my session write waits for the flag', async () => {
    // Given a flag write still in flight, such as a request to the dev store
    const landed = deferred<undefined>();
    const asked = deferred<undefined>();
    const slow: SessionPresence = {
      read: () => Promise.resolve('absent'),
      set: () => {
        asked.resolve(undefined);
        return landed.promise;
      },
      clear: () => Promise.resolve(),
      renew: () => Promise.resolve(),
    };
    const storage = windowCoreStorage(slow).adapters();

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

  it('As a product page, I let my core rewrite its session and never set the cookie', async () => {
    // Given a product page's core over an absent flag
    presence.state = 'absent';
    const storage = coreStorage.adapters();

    // When the core writes its session
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // Then the flag is never set
    expect(presence.calls).not.toContain('set');
    expect(presence.state).toBe('absent');
  });

  it('As a local wallet page, I let my core run and leave the cookie alone', async () => {
    // Given a core whose session lives in memory
    const storage = coreStorage.adapters({ sessionInMemory: true });

    // When the core clears its session
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the cookie is not touched
    expect(presence.calls).not.toContain('clear');
  });

  it('As a page, I drop the dead session I read and it goes with its account while my cores hear it', async () => {
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

  it('As a page whose core drops the session it read, I lose the session with its account and the cookie', async () => {
    // Given a stored session with its account that the core read
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    const storage = coreStorage.adapters();
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When the core clears it
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then both go and the cookie is deleted
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
    expect(shared.entries.has(UI_STATE_CACHE_KEY)).toBe(false);
    expect(presence.calls).toContain('clear');
  });

  it('As a page whose core drops its session after another tab signed in, I keep the new sign-in and its cookie', async () => {
    // Given my core holding the session it read, then another tab's sign-in, which set the cookie first
    shared.entries.set(SESSION_KEY, '0x010203');
    const storage = coreStorage.adapters();
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

  it('As a page whose core holds no session, I clear it and leave a session another core stored alone', async () => {
    // Given a core that read an empty store, then a session stored by another core
    const storage = coreStorage.adapters();
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    shared.entries.set(SESSION_KEY, '0x0a0b');

    // When the core clears
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the other session stays and nothing was cleared
    expect(shared.entries.get(SESSION_KEY)).toBe('0x0a0b');
    expect(shared.clears).toEqual([]);
    expect(presence.calls).toEqual([]);
  });

  it("As a page whose store refuses my core's clear, I still delete the cookie so every page drops it on load", async () => {
    // Given a core session whose clear the store refuses
    onTestFinished(bindCaptureSink({ exception: vi.fn(), expected: vi.fn() }));
    const storage = coreStorage.adapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    shared.clearError = key => (key === SESSION_KEY ? UNREACHABLE : null);

    // When the core clears it
    const cleared = storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the clear rejects and the cookie is still deleted
    await expect(cleared).rejects.toBe(UNREACHABLE);
    expect(presence.calls).toContain('clear');
  });

  it('As a page whose core drops its session while the flag stays, I still clear the session', async () => {
    // Given a core session whose flag cannot be cleared
    const failure = new Error('cookie blocked');
    const unwritable = createPagePresence({
      shared: () => true,
      localhost: false,
      channel: () => {
        throw new Error('no dev store on a deployed page');
      },
      jar: {
        read: () => '',
        write: () => {
          throw failure;
        },
      },
    });
    const { counted, captures, coreStorage: reporting } = loadWithMetrics(shared, unwritable);
    const storage = reporting.adapters();
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

  it('As a user in the sign-in window whose core drops its session while a wallet stays stored, I keep the cookie for the wallet', async () => {
    // Given a window's core session beside a stored wallet
    const storage = windowCoreStorage(presence, true).adapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // When the core clears it
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the session goes and the flag stays for the wallet
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
    expect(presence.calls).not.toContain('clear');
    expect(presence.state).toBe('present');
  });

  it('As a user in the sign-in window whose core drops the last sign-in stored, I lose the cookie with it', async () => {
    // Given a window's core session that is the last sign-in stored
    const storage = windowCoreStorage(presence).adapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // When the core clears it
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then the session goes and the flag drops
    expect(shared.entries.has(SESSION_KEY)).toBe(false);
    expect(presence.state).toBe('absent');
  });
});
