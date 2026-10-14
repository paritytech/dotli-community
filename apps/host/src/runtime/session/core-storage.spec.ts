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
import { memoryStorage, must } from '@dotli/shared/testing';

const SESSION_KEY = SHARED_CORE_SESSION_KEY;
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;
const AUTH_SESSION_KEY = { tag: 'AuthSession' as const };
const UNREACHABLE = new Error('protocol iframe never listened');
const CACHED_UI_STATE = JSON.stringify({ connected: true, liteUsername: 'pgherveou.04' });

/** A core storage over the given store, with a fake Sentry and capture sink bound for this test, for the tests that read what it reports. */
function loadWithMetrics(shared: FakeSharedSessionStore) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const captures = { exception: vi.fn(), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  return {
    counts: metrics.counts,
    counted: metrics.counted,
    captures,
    coreStorage: createCoreStorage({ shared, local: () => local, keyDb: () => keyDb }),
  };
}

let shared: FakeSharedSessionStore;
let coreStorage: HostCoreStorage;
let local: Storage;
let keyDb: IDBFactory;

describe('core storage', () => {
  beforeEach(() => {
    local = memoryStorage();
    keyDb = new IDBFactory();
    shared = createFakeSharedSessionStore();
    coreStorage = createCoreStorage({ shared, local: () => local, keyDb: () => keyDb });
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

  it('As a returning user whose shared store cannot be read, the session read is recorded once as an environment failure and reads as none', async () => {
    // Given a shared store that cannot be reached
    const { counted, captures, coreStorage } = loadWithMetrics(shared);
    shared.readError = UNREACHABLE;

    // When the session is read
    const session = await coreStorage.readSession();

    // Then it reads as none, with one breadcrumb, no issue and one failed read counted
    expect(session).toBeNull();
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
    shared.write = () => Promise.reject(UNREACHABLE);

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
    const clear = shared.clear.bind(shared);
    shared.clear = key => (key === UI_STATE_CACHE_KEY ? Promise.reject(UNREACHABLE) : clear(key));

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

  it('As a local wallet user, my core never reads, writes or clears the paired session', async () => {
    // Given
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    const storage = coreStorage.adapters({ local: true });

    // When
    const read = await storage.readCoreStorage(AUTH_SESSION_KEY);
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9, 9]));
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(read).toBeUndefined();
    expect(shared.entries.get(SESSION_KEY)).toBe('0x010203');
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBe(CACHED_UI_STATE);
  });

  it('As a Polkadot App user back from a local wallet, my core reads, writes and clears the paired session', async () => {
    // Given
    shared.entries.set(SESSION_KEY, '0x010203');
    shared.entries.set(UI_STATE_CACHE_KEY, CACHED_UI_STATE);
    const storage = coreStorage.adapters();

    // When
    const read = await storage.readCoreStorage(AUTH_SESSION_KEY);
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9, 9]));
    const written = shared.entries.get(SESSION_KEY);
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(Array.from(read ?? [])).toEqual([1, 2, 3]);
    expect(written).toBe('0x0909');
    expect(shared.entries.get(SESSION_KEY)).toBeUndefined();
    expect(shared.entries.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });
});
