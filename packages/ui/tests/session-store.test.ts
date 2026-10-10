import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED_CORE_SESSION_KEY, type SharedStoreStatus } from '@dotli/protocol';
import { SITE_ID } from '@dotli/config';
import type { CoreStorageKey, SessionUiInfo } from '@parity/truapi-host';
import { must } from './support.js';

const localWallet = vi.hoisted((): { result: unknown } => ({ result: { status: 'none' } }));

const sharedAuth = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  listeners: new Set<(change: { siteId: string; key: string; value: string | null }) => void>(),
  readError: null as Error | null,
  reads: [] as string[],
  // While set, reads wait on it, so a test can hold one in flight.
  readGate: null as Promise<void> | null,
}));

const sharedStore = vi.hoisted(
  (): { status: SharedStoreStatus; listeners: Set<(status: SharedStoreStatus) => void> } => ({
    status: 'connecting',
    listeners: new Set(),
  }),
);

vi.mock('../../protocol/src/client.js', () => ({
  readSharedLocalWallet: () => Promise.resolve(localWallet.result),
  readSharedAuthStorage: async (siteId: string, key: string) => {
    sharedAuth.reads.push(key);
    await sharedAuth.readGate;
    if (sharedAuth.readError !== null) {
      throw sharedAuth.readError;
    }
    return sharedAuth.storage.get(`${siteId}:${key}`) ?? null;
  },
  writeSharedAuthStorage: (siteId: string, key: string, value: string) => {
    sharedAuth.storage.set(`${siteId}:${key}`, value);
    return Promise.resolve();
  },
  clearSharedAuthStorage: (siteId: string, key: string) => {
    sharedAuth.storage.delete(`${siteId}:${key}`);
    return Promise.resolve();
  },
  subscribeSharedAuthStorage: (listener: (change: { siteId: string; key: string; value: string | null }) => void) => {
    sharedAuth.listeners.add(listener);
    return () => {
      sharedAuth.listeners.delete(listener);
    };
  },
  getSharedStoreStatus: () => sharedStore.status,
  subscribeSharedStoreStatus: (listener: (status: SharedStoreStatus) => void) => {
    sharedStore.listeners.add(listener);
    return () => {
      sharedStore.listeners.delete(listener);
    };
  },
}));

/** The shared store reporting a status change, as the protocol client does. */
function setStoreStatus(status: SharedStoreStatus): void {
  sharedStore.status = status;
  for (const listener of sharedStore.listeners) {
    listener(status);
  }
}

const STORAGE_KEY = `${SITE_ID}:${SHARED_CORE_SESSION_KEY}`;
const UI_STATE_CACHE_KEY = `${SITE_ID}:${SHARED_CORE_SESSION_KEY}:ui-state`;
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

// `readWalletBoot` caches its read per module instance, so each test loads a fresh set that tests and code share.
async function loadModules() {
  const [sessionStore, authState, auth, createStore, walletMode] = await Promise.all([
    import('../src/host-callbacks/SessionStore.js'),
    import('../src/host-callbacks/AuthState.js'),
    import('../src/state/auth.js'),
    import('../src/state/create-store.js'),
    import('../src/state/wallet-mode.js'),
  ]);
  return {
    createSessionStoreAdapters: sessionStore.createSessionStoreAdapters,
    refreshSavedSession: sessionStore.refreshSavedSession,
    startSessionState: sessionStore.startSessionState,
    onStoredSessionChanged: sessionStore.onStoredSessionChanged,
    createAuthStateChanged: authState.createAuthStateChanged,
    getAuthState: auth.getAuthState,
    setAuthState: auth.setAuthState,
    resetAllStoresForTests: createStore.resetAllStoresForTests,
    setWalletModeState: walletMode.setWalletModeState,
  };
}

/** A fresh session store with metrics on and a fake Sentry bound, for the tests that read what it counts. */
async function loadWithMetrics() {
  vi.stubEnv('VITE_METRICS', 'true');
  vi.resetModules();
  const [{ m }, sessionStore] = await Promise.all([
    import('../../metrics/src/metrics.js'),
    import('../src/host-callbacks/SessionStore.js'),
  ]);
  const count = vi.fn();
  m.bind({
    startSpan: vi.fn(),
    startInactiveSpan: vi.fn(),
    setMeasurement: vi.fn(),
    metrics: { count, distribution: vi.fn(), gauge: vi.fn() },
    setTag: vi.fn(),
    addBreadcrumb: vi.fn(),
  });
  return { count, createSessionStoreAdapters: sessionStore.createSessionStoreAdapters };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;
let createSessionStoreAdapters: Modules['createSessionStoreAdapters'];
let refreshSavedSession: Modules['refreshSavedSession'];
let startSessionState: Modules['startSessionState'];
let onStoredSessionChanged: Modules['onStoredSessionChanged'];
let createAuthStateChanged: Modules['createAuthStateChanged'];
let getAuthState: Modules['getAuthState'];
let setAuthState: Modules['setAuthState'];
let resetAllStoresForTests: Modules['resetAllStoresForTests'];
let setWalletModeState: Modules['setWalletModeState'];

describe('session-store host callbacks', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({
      createSessionStoreAdapters,
      refreshSavedSession,
      startSessionState,
      onStoredSessionChanged,
      createAuthStateChanged,
      getAuthState,
      setAuthState,
      resetAllStoresForTests,
      setWalletModeState,
    } = await loadModules());
    localWallet.result = { status: 'none' };
    localStorage.clear();
    sharedAuth.storage.clear();
    sharedAuth.listeners.clear();
    sharedAuth.readError = null;
    sharedAuth.reads.length = 0;
    sharedAuth.readGate = null;
    sharedStore.status = 'connecting';
    sharedStore.listeners.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    // Each test is a fresh page, whose auth state is Restoring until the saved session is read.
    resetAllStoresForTests();
  });

  it('As a dotli integrator, the host round-trips the host core session blob', async () => {
    // Given
    const storage = createSessionStoreAdapters();

    expect(await storage.readCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();

    // When
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // Then
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBe('0x010203');
    expect(localStorage.length).toBe(0);
    expect(Array.from((await storage.readCoreStorage(AUTH_SESSION_KEY)) ?? [])).toEqual([1, 2, 3]);

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBeUndefined();
    expect(await storage.readCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();
  });

  it('As a dotli integrator, the host round-trips permission authorization slots from typed core keys', async () => {
    // Given
    const storage = createSessionStoreAdapters();
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
    expect(localStorage.length).toBe(1);
    const storageKey = localStorage.key(0);
    expect(storageKey).toMatch(/^dotli:core:permission:[0-9a-f]+$/);
    expect(storageKey).not.toContain('open-url');
    expect(localStorage.getItem(storageKey ?? '')).toBe('0x04');
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([4]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
  });

  it('As a dotli integrator, the host keeps remote permission authorization keys opaque', async () => {
    // Given
    const storage = createSessionStoreAdapters();
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
    const storageKey = localStorage.key(0);
    expect(storageKey).toMatch(/^dotli:core:permission:[0-9a-f]+$/);
    expect(storageKey).not.toContain('example');
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([7]);
    expect(localStorage.length).toBe(1);
  });

  it('As a dotli integrator, the host encrypts persisted allowance key slots', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));

    // Then
    const storageKey = 'dotli:core:allowance-keys:session-1';
    expect(localStorage.getItem(storageKey)).not.toBe('0x01020304');
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([1, 2, 3, 4]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
  });

  it('As a dotli integrator, the host encrypts product auto-signing keys in opaque slots', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    const key = {
      tag: 'AutoSigningKey',
      value: { productId: 'truapi-playground.dot' },
    } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([5, 6, 7, 8]));

    // Then
    expect(localStorage.length).toBe(1);
    const storageKey = localStorage.key(0);
    expect(storageKey).toMatch(/^dotli:core:auto-signing:[0-9a-f]+$/);
    expect(storageKey).not.toContain('truapi-playground.dot');
    expect(localStorage.getItem(storageKey ?? '')).toMatch(/^enc1:0x/);
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([5, 6, 7, 8]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
  });

  it('As a dotli integrator, the host encrypts the device encryption secret in a stable install-wide slot', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    const key = { tag: 'DeviceEncryptionKey' } satisfies CoreStorageKey;

    // When
    await storage.writeCoreStorage(key, new Uint8Array([9, 10, 11, 12]));

    // Then
    // Peers address this device by the public counterpart, so the slot name
    // must not move with the session: a fresh name would orphan them.
    const storageKey = 'dotli:core:device-encryption-key';
    expect(localStorage.getItem(storageKey)).toMatch(/^enc1:0x/);
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([9, 10, 11, 12]);

    // When
    await storage.clearCoreStorage(key);

    // Then
    expect(await storage.readCoreStorage(key)).toBeUndefined();
  });

  it('As a dotli integrator, the host stores product subtree keys per session in opaque plaintext slots', async () => {
    // Given
    const storage = createSessionStoreAdapters();
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
    expect(localStorage.length).toBe(2);
    for (const index of [0, 1]) {
      const storageKey = localStorage.key(index);
      expect(storageKey).toMatch(/^dotli:core:product-subtree:[0-9a-f]+$/);
      expect(storageKey).not.toContain('truapi-playground.dot');
      expect(localStorage.getItem(storageKey ?? '')).toMatch(/^0x/);
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
    const storage = createSessionStoreAdapters();
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
    expect(localStorage.length).toBe(2);
    for (const index of [0, 1]) {
      const storageKey = localStorage.key(index);
      expect(storageKey).toMatch(/^dotli:core:sso-responder-ledger:[0-9a-f]+$/);
      expect(localStorage.getItem(storageKey ?? '')).toMatch(/^0x/);
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
    const storage = createSessionStoreAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:session-1';

    // When: the same plaintext is written twice
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const first = localStorage.getItem(storageKey);
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const second = localStorage.getItem(storageKey);

    // Then: the ciphertexts differ (fresh nonce per write) and still decrypt
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('As a dotli integrator, the host encrypts allowance keys under a non-extractable per-install key', async () => {
    // Given
    const storage = createSessionStoreAdapters();
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
      const request = indexedDB.open('dotli-core');
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
    const storage = createSessionStoreAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'legacy' },
    } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:legacy';
    localStorage.setItem(storageKey, '0x01020304');

    // When
    const bytes = await storage.readCoreStorage(key);

    // Then: the legacy bytes are readable and re-persisted encrypted
    expect(Array.from(bytes ?? [])).toEqual([1, 2, 3, 4]);
    expect(localStorage.getItem(storageKey)).toMatch(/^enc1:0x/);
    expect(Array.from((await storage.readCoreStorage(key)) ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('As a dotli integrator, the host drops allowance slots that no longer decrypt instead of returning ciphertext', async () => {
    // Given: an encrypted slot whose ciphertext no longer authenticates —
    // the same shape as a key lost to an IndexedDB wipe or tampered bytes
    const storage = createSessionStoreAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:session-1';
    await storage.writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const stored = localStorage.getItem(storageKey) ?? '';
    const flipped = stored.slice(0, -2) + (stored.endsWith('00') ? 'ff' : '00');
    localStorage.setItem(storageKey, flipped);

    // When
    const bytes = await storage.readCoreStorage(key);

    // Then: a true cache miss — ciphertext is never handed back as key
    // material, and the dead slot is removed rather than re-encrypted
    expect(bytes).toBeUndefined();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('As a dotli integrator, the host treats corrupt persisted core bytes as a cache miss', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'corrupt' },
    } satisfies CoreStorageKey;
    localStorage.setItem('dotli:core:allowance-keys:corrupt', 'not-hex');

    // When
    const stored = storage.readCoreStorage(key);

    // Then
    await expect(stored).resolves.toBeUndefined();
  });

  it('As a dotli integrator, the host treats a corrupt shared auth session as a cache miss', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    sharedAuth.storage.set(STORAGE_KEY, 'not-hex');

    // When
    const stored = storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    await expect(stored).resolves.toBeUndefined();
  });

  it('As an operator, I see each shared session read counted as a hit or a miss', async () => {
    // Given
    const { count, createSessionStoreAdapters } = await loadWithMetrics();
    const storage = createSessionStoreAdapters();
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    sharedAuth.storage.set(STORAGE_KEY, '0x010203');

    // When
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(count.mock.calls).toEqual([
      ['dotli.shared_session.read', 1, { attributes: { outcome: 'miss' } }],
      ['dotli.shared_session.read', 1, { attributes: { outcome: 'hit' } }],
    ]);
  });

  it('As an operator, I see a failed shared session read counted with its error name', async () => {
    // Given
    const { count, createSessionStoreAdapters } = await loadWithMetrics();
    const storage = createSessionStoreAdapters();
    sharedAuth.storage.set(STORAGE_KEY, '0x010203');
    const timeout = new Error('Protocol request "authStorageRead" timed out after 30000ms');
    timeout.name = 'ProtocolTimeoutError';
    sharedAuth.readError = timeout;

    // When
    const stored = await storage.readCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(stored).toBeUndefined();
    expect(count).toHaveBeenCalledWith('dotli.shared_session.read', 1, {
      attributes: { outcome: 'error', reason: 'ProtocolTimeoutError' },
    });
  });

  it('As a returning user whose saved session could not be read, the disconnect that follows shows as unreachable and keeps my cached account', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    const authStateChanged = createAuthStateChanged('Polkadot Web');
    sharedAuth.storage.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    sharedAuth.readError = UNREACHABLE;
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When
    authStateChanged({ tag: 'Disconnected' });
    await flushMicrotasks();

    // Then
    expect(getAuthState()).toEqual({ tag: 'Unreachable' });
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBe(JSON.stringify(CONNECTED_DETAIL));
  });

  it('As a returning user whose store answers again, the next disconnect is a plain logout', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    const authStateChanged = createAuthStateChanged('Polkadot Web');
    sharedAuth.readError = UNREACHABLE;
    await storage.readCoreStorage(AUTH_SESSION_KEY);
    sharedAuth.readError = null;
    await storage.readCoreStorage(AUTH_SESSION_KEY);

    // When
    authStateChanged({ tag: 'Disconnected' });

    // Then
    expect(getAuthState()).toEqual({ tag: 'Disconnected' });
  });

  it('As a returning user, the host reads my saved session as soon as session state starts, without waking running cores', async () => {
    // Given
    sharedAuth.storage.set(STORAGE_KEY, '0x010203');
    sharedAuth.storage.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    const coreNotified = vi.fn();
    const unsubscribe = onStoredSessionChanged(coreNotified);

    // When
    const stop = startSessionState();

    // Then
    await vi.waitFor(() => {
      expect(getAuthState()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    });
    expect(coreNotified).not.toHaveBeenCalled();
    stop();
    unsubscribe();
  });

  it('As a signed-out user whose shared store goes down, I am shown as unreachable, not signed out', async () => {
    // Given
    const stop = startSessionState();
    await vi.waitFor(() => {
      expect(getAuthState()).toEqual({ tag: 'Disconnected' });
    });

    // When
    setStoreStatus('unavailable');

    // Then
    expect(getAuthState()).toEqual({ tag: 'Unreachable' });
    stop();
  });

  it('As a signed-in user whose shared store goes down, I stay signed in', () => {
    // Given
    const stop = startSessionState();
    setAuthState({ tag: 'Connected', session: CONNECTED_DETAIL });

    // When
    setStoreStatus('unavailable');

    // Then
    expect(getAuthState()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    stop();
  });

  it('As a returning user whose shared store comes back, my session is read again and running cores are told', async () => {
    // Given
    sharedAuth.storage.set(STORAGE_KEY, '0x010203');
    sharedAuth.storage.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    sharedAuth.readError = UNREACHABLE;
    const stop = startSessionState();
    setStoreStatus('unavailable');
    await vi.waitFor(() => {
      expect(getAuthState()).toEqual({ tag: 'Unreachable' });
    });
    const coreNotified = vi.fn();
    const unsubscribe = onStoredSessionChanged(coreNotified);

    // When
    sharedAuth.readError = null;
    setStoreStatus('available');

    // Then
    await vi.waitFor(() => {
      expect(getAuthState()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
    });
    expect(coreNotified).toHaveBeenCalledTimes(1);
    stop();
    unsubscribe();
  });

  it('As a dotli integrator, a refresh asked during a read waits for it, so the later read decides', async () => {
    // Given
    const gate: PromiseWithResolvers<void> = Promise.withResolvers();
    sharedAuth.readGate = gate.promise;
    const sessionReads = (): number => sharedAuth.reads.filter(key => key === SHARED_CORE_SESSION_KEY).length;
    const first = refreshSavedSession();
    await flushMicrotasks();

    // When
    sharedAuth.storage.set(STORAGE_KEY, '0x010203');
    sharedAuth.storage.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    const second = refreshSavedSession();
    await flushMicrotasks();
    const readsWhileHeld = sessionReads();
    gate.resolve();
    await Promise.all([first, second]);

    // Then
    expect(readsWhileHeld).toBe(1);
    expect(sessionReads()).toBe(2);
    expect(getAuthState()).toEqual({ tag: 'Connected', session: CONNECTED_DETAIL });
  });

  it('As a dotli integrator, starting session state twice keeps one subscription to the shared store', () => {
    // When
    const first = startSessionState();
    const second = startSessionState();

    // Then
    expect(second).toBe(first);
    expect(sharedStore.listeners.size).toBe(1);
    first();
  });

  it('As a dotli integrator, the host emits the typed session identity details from a connected auth state', () => {
    // Given
    const authStateChanged = createAuthStateChanged('Polkadot Web');
    const events: unknown[] = [];
    window.addEventListener('dotli:truapi-auth-state', event => {
      events.push((event as CustomEvent).detail);
    });

    // When
    authStateChanged({
      tag: 'Connected',
      value: connectedSessionUiInfo(),
    });

    // Then
    expect(events).toEqual([{ tag: 'Connected', session: CONNECTED_DETAIL }]);
  });

  it('As a dotli integrator, the host dispatches the pairing presentation with its host context', () => {
    // Given
    const authStateChanged = createAuthStateChanged('Polkadot Web', {
      dotSuffix: false,
      hostGlobal: true,
    });
    const events: unknown[] = [];
    window.addEventListener('dotli:truapi-auth-state', event => {
      events.push((event as CustomEvent).detail);
    });

    // When
    authStateChanged({
      tag: 'Pairing',
      value: { deeplink: 'polkadotapp://pair?handshake=test' },
    });

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
    const authStateChanged = createAuthStateChanged('Polkadot Web');
    const events: unknown[] = [];
    window.addEventListener('dotli:truapi-auth-state', event => {
      events.push((event as CustomEvent).detail);
    });

    // When
    authStateChanged({ tag: 'Authenticating' });

    // Then
    expect(events).toEqual([{ tag: 'Authenticating' }]);
  });

  it('As a dotli integrator, the host caches the connected UI state and clears it with the session', async () => {
    // Given
    const authStateChanged = createAuthStateChanged('Polkadot Web');
    const storage = createSessionStoreAdapters();

    // When
    authStateChanged({
      tag: 'Connected',
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();

    // Then
    expect(JSON.parse(sharedAuth.storage.get(UI_STATE_CACHE_KEY) ?? '')).toEqual(CONNECTED_DETAIL);

    // When
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it('As a dotli integrator, the host clears the cached UI state on a disconnected auth state', async () => {
    // Given
    const authStateChanged = createAuthStateChanged('Polkadot Web');

    authStateChanged({
      tag: 'Connected',
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeDefined();

    // When
    authStateChanged({ tag: 'Disconnected' });
    await flushMicrotasks();

    // Then
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it('As a dotli integrator, the host rehydrates the cached session UI state', async () => {
    // Given
    const authStateChanged = createAuthStateChanged('Polkadot Web');
    const storage = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener('dotli:truapi-auth-state', event => {
      events.push((event as CustomEvent).detail);
    });

    // Nothing persisted: signed out, even with a stale cache entry.
    sharedAuth.storage.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    await refreshSavedSession();
    await vi.waitFor(() => {
      expect(events).toEqual([{ tag: 'Disconnected' }]);
    });
    sharedAuth.storage.delete(UI_STATE_CACHE_KEY);

    // When: a login persists the session, then a reload reads it back.
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    authStateChanged({
      tag: 'Connected',
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    resetAllStoresForTests();
    events.length = 0;

    await refreshSavedSession();

    // Then
    await vi.waitFor(() => {
      expect(events).toEqual([{ tag: 'Connected', session: CONNECTED_DETAIL }]);
    });
  });

  it('As a visitor without a saved session, boot ends the unknown state as signed out', async () => {
    // When
    await refreshSavedSession();

    // Then
    await vi.waitFor(() => {
      expect(getAuthState()).toEqual({ tag: 'Disconnected' });
    });
  });

  it('As a user pairing before boot read the saved session, finding none leaves my pairing alone', async () => {
    // Given
    createAuthStateChanged('myapp')({ tag: 'Pairing', value: { deeplink: 'polkadotapp://pair' } });

    // When
    await refreshSavedSession();

    // Then
    expect(getAuthState().tag).toBe('Pairing');
  });

  it('As a user whose session the core already reported, the saved copy read later does not override it', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    createAuthStateChanged('myapp')({ tag: 'Disconnected' });

    // When
    await refreshSavedSession();

    // Then
    expect(getAuthState()).toEqual({ tag: 'Disconnected' });
  });

  it('As a dotli integrator, the host rehydrates a bare connected state when no cache exists', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener('dotli:truapi-auth-state', event => {
      events.push((event as CustomEvent).detail);
    });

    // When
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    await refreshSavedSession();

    // Then
    await vi.waitFor(() => {
      expect(events).toEqual([{ tag: 'Connected', session: { connected: true } }]);
    });
  });

  it('As a dotli integrator, the host degrades to a bare connected state when the cached UI state is malformed', async () => {
    // Given: a persisted session, but a UI-state cache whose fields no longer
    // match the expected shape (e.g. written by a different code version).
    const storage = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener('dotli:truapi-auth-state', event => {
      events.push((event as CustomEvent).detail);
    });
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    sharedAuth.storage.set(UI_STATE_CACHE_KEY, JSON.stringify({ connected: true, publicKey: 42, liteUsername: null }));

    // When
    await refreshSavedSession();

    // Then: the malformed cache is discarded instead of being laundered into
    // a typed session state with non-string fields.
    await vi.waitFor(() => {
      expect(events).toEqual([{ tag: 'Connected', session: { connected: true } }]);
    });
  });

  it('As a dotli integrator, the host notifies local and matching storage changes', async () => {
    // Given
    const storage = createSessionStoreAdapters();
    const listener = vi.fn();
    const unsubscribe = onStoredSessionChanged(listener);

    // When
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9]));

    // Then
    expect(listener).toHaveBeenCalledTimes(1);

    // When
    for (const sharedListener of sharedAuth.listeners) {
      sharedListener({
        siteId: SITE_ID,
        key: SHARED_CORE_SESSION_KEY,
        value: '0x09',
      });
    }

    // Then
    expect(listener).toHaveBeenCalledTimes(2);

    // When
    unsubscribe();
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([8]));

    // Then
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('As a local wallet user, I see my cached account at page load without a core', async () => {
    // Given
    localWallet.result = {
      status: 'ok',
      entropy: new Uint8Array(16),
      identity: { identityAccountId: `0x${'11'.repeat(32)}`, liteUsername: 'alice.42' },
    };

    // When
    await refreshSavedSession();

    // Then
    await vi.waitFor(() => {
      expect(getAuthState()).toEqual({
        tag: 'Connected',
        session: {
          connected: true,
          identityAccountId: `0x${'11'.repeat(32)}`,
          liteUsername: 'alice.42',
          primaryUsername: 'alice.42',
        },
      });
    });
  });

  it('As a local wallet user before the first network read, I am shown signed in without a name', async () => {
    // Given
    localWallet.result = { status: 'ok', entropy: new Uint8Array(16), identity: null };

    // When
    await refreshSavedSession();

    // Then
    await vi.waitFor(() => {
      expect(getAuthState()).toEqual({ tag: 'Connected', session: { connected: true } });
    });
  });

  it('As a local wallet user, my session never overwrites the paired session cache', async () => {
    // Given
    sharedAuth.storage.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    setWalletModeState({ mode: 'local', failure: null });
    const authStateChanged = createAuthStateChanged('Polkadot Web');

    // When
    authStateChanged({ tag: 'Connected', value: connectedSessionUiInfo() });
    authStateChanged({ tag: 'Disconnected' });
    await flushMicrotasks();

    // Then
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBe(JSON.stringify(CONNECTED_DETAIL));
  });

  it('As a local wallet user, my core never reads, writes or clears the paired session', async () => {
    // Given
    sharedAuth.storage.set(STORAGE_KEY, '0x010203');
    sharedAuth.storage.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    const storage = createSessionStoreAdapters({ local: true });

    // When
    const read = await storage.readCoreStorage(AUTH_SESSION_KEY);
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9, 9]));
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(read).toBeUndefined();
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBe('0x010203');
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBe(JSON.stringify(CONNECTED_DETAIL));
  });

  it('As a Polkadot App user back from a local wallet, my core reads, writes and clears the paired session', async () => {
    // Given
    sharedAuth.storage.set(STORAGE_KEY, '0x010203');
    sharedAuth.storage.set(UI_STATE_CACHE_KEY, JSON.stringify(CONNECTED_DETAIL));
    const storage = createSessionStoreAdapters();

    // When
    const read = await storage.readCoreStorage(AUTH_SESSION_KEY);
    await storage.writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9, 9]));
    const written = sharedAuth.storage.get(STORAGE_KEY);
    await storage.clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(Array.from(read ?? [])).toEqual([1, 2, 3]);
    expect(written).toBe('0x0909');
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBeUndefined();
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });
});
