import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import { SITE_ID } from "@dotli/config/config";
let createSessionStoreAdapters: typeof import("@dotli/ui/host-callbacks/SessionStore").createSessionStoreAdapters;
let emitPersistedSessionUiState: typeof import("@dotli/ui/host-callbacks/SessionStore").emitPersistedSessionUiState;
let onStoredSessionChanged: typeof import("@dotli/ui/host-callbacks/SessionStore").onStoredSessionChanged;
import { createAuthStateChanged } from "@dotli/ui/host-callbacks/AuthState";
import type { CoreStorageKey, SecretCoreStorageKey } from "@parity/truapi-host";

const sharedAuth = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  readFailure: undefined as Error | undefined,
  listeners: new Set<
    (change: { siteId: string; key: string; value: string | null }) => void
  >(),
}));

vi.mock("@dotli/protocol/client", () => ({
  readSharedAuthStorage: async (siteId: string, key: string) => {
    if (sharedAuth.readFailure) throw sharedAuth.readFailure;
    return sharedAuth.storage.get(`${siteId}:${key}`) ?? null;
  },
  writeSharedAuthStorage: async (
    siteId: string,
    key: string,
    value: string,
  ) => {
    sharedAuth.storage.set(`${siteId}:${key}`, value);
  },
  clearSharedAuthStorage: async (siteId: string, key: string) => {
    sharedAuth.storage.delete(`${siteId}:${key}`);
  },
  subscribeSharedAuthStorage: (
    listener: (change: {
      siteId: string;
      key: string;
      value: string | null;
    }) => void,
  ) => {
    sharedAuth.listeners.add(listener);
    return () => {
      sharedAuth.listeners.delete(listener);
    };
  },
}));

const STORAGE_KEY = `${SITE_ID}:${SHARED_CORE_SESSION_KEY}`;
const UI_STATE_CACHE_KEY = `${SITE_ID}:${SHARED_CORE_SESSION_KEY}:ui-state`;
const AUTH_SESSION_KEY = { tag: "AuthSession" as const };

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// The core reports these as `Bytes32` (hex), so the UI state carries them
// through unchanged rather than encoding them.
const SESSION_PUBLIC_KEY =
  "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SESSION_IDENTITY_ACCOUNT_ID =
  "0xa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf";

function connectedSessionUiInfo() {
  return {
    publicKey: SESSION_PUBLIC_KEY,
    identityAccountId: SESSION_IDENTITY_ACCOUNT_ID,
    liteUsername: "pgherveou.04",
  };
}

const CONNECTED_DETAIL = {
  connected: true,
  publicKey: SESSION_PUBLIC_KEY,
  identityAccountId: SESSION_IDENTITY_ACCOUNT_ID,
  liteUsername: "pgherveou.04",
  primaryUsername: "pgherveou.04",
};

describe("session-store host callbacks", () => {
  beforeEach(async () => {
    localStorage.clear();
    sharedAuth.storage.clear();
    sharedAuth.readFailure = undefined;
    sharedAuth.listeners.clear();
    vi.restoreAllMocks();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.resetModules();
    ({
      createSessionStoreAdapters,
      emitPersistedSessionUiState,
      onStoredSessionChanged,
    } = await import("@dotli/ui/host-callbacks/SessionStore"));
  });

  it("As a dotli integrator, the host round-trips the host core session blob", async () => {
    // Given
    const {
      readSecretCoreStorage,
      writeSecretCoreStorage,
      clearSecretCoreStorage,
    } = createSessionStoreAdapters();

    expect(await readSecretCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();

    // When
    await writeSecretCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // Then
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBe("0x010203");
    expect(localStorage.length).toBe(0);
    expect(
      Array.from((await readSecretCoreStorage(AUTH_SESSION_KEY)) ?? []),
    ).toEqual([1, 2, 3]);

    // When
    await clearSecretCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBeUndefined();
    expect(await readSecretCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();
  });

  it("As a dotli integrator, the host round-trips permission authorization slots from typed core keys", async () => {
    // Given
    const { readCoreStorage, writeCoreStorage, clearCoreStorage } =
      createSessionStoreAdapters();
    const key = {
      tag: "PermissionAuthorization",
      value: {
        productId: "My App",
        request: { tag: "Device", value: "OpenUrl" },
      },
    } satisfies CoreStorageKey;

    // When
    await writeCoreStorage(key, new Uint8Array([4]));

    // Then
    expect(localStorage.length).toBe(1);
    const storageKey = localStorage.key(0);
    expect(storageKey).toMatch(/^dotli:core:permission:[0-9a-f]+$/);
    expect(storageKey).not.toContain("open-url");
    expect(localStorage.getItem(storageKey ?? "")).toBe("0x04");
    expect(Array.from((await readCoreStorage(key)) ?? [])).toEqual([4]);

    // When
    await clearCoreStorage(key);

    // Then
    expect(await readCoreStorage(key)).toBeUndefined();
  });

  it("As a dotli integrator, the host keeps remote permission authorization keys opaque", async () => {
    // Given
    const { readCoreStorage, writeCoreStorage } = createSessionStoreAdapters();
    const key = {
      tag: "PermissionAuthorization",
      value: {
        productId: "myapp",
        request: {
          tag: "Remote",
          value: {
            permission: {
              tag: "Remote",
              value: { domains: ["B.example", "a.example", "b.example"] },
            },
          },
        },
      },
    } satisfies CoreStorageKey;

    // When
    await writeCoreStorage(key, new Uint8Array([7]));

    // Then
    const storageKey = localStorage.key(0);
    expect(storageKey).toMatch(/^dotli:core:permission:[0-9a-f]+$/);
    expect(storageKey).not.toContain("example");
    expect(Array.from((await readCoreStorage(key)) ?? [])).toEqual([7]);
    expect(localStorage.length).toBe(1);
  });

  it("keeps public product, peer and registry records in distinct typed slots", async () => {
    const callbacks = createSessionStoreAdapters();
    const keys: CoreStorageKey[] = [
      {
        tag: "ProductSubtree",
        value: { sessionId: "a", productId: "app.dot" },
      },
      {
        tag: "ProductSubtree",
        value: { sessionId: "b", productId: "app.dot" },
      },
      { tag: "ProductManifest", value: { productId: "app.dot" } },
      { tag: "ProductManifest", value: { productId: "other.dot" } },
      { tag: "RingVrfRegistry", value: { rootPublicKey: new Uint8Array(32) } },
      {
        tag: "SsoResponderRequestLedger",
        value: {
          rootPublicKey: new Uint8Array(32),
          peerStatementAccountId: new Uint8Array(32),
          peerEncryptionPublicKey: new Uint8Array(32),
        },
      },
    ];
    for (const [index, key] of keys.entries()) {
      await callbacks.writeCoreStorage(key, new Uint8Array([index]));
    }
    expect(
      await Promise.all(keys.map((key) => callbacks.readCoreStorage(key))),
    ).toEqual(keys.map((_, index) => new Uint8Array([index])));
    expect(sharedAuth.storage.size).toBe(0);
  });

  it("encrypts device keys without moving shared auth or pairing identity into that origin key", async () => {
    const callbacks = createSessionStoreAdapters();
    await callbacks.writeSecretCoreStorage(
      { tag: "DeviceEncryptionKey" },
      new Uint8Array([1, 2]),
    );
    expect(localStorage.getItem("dotli:core:device-encryption-key")).toMatch(
      /^enc1:0x/,
    );
    expect(
      await callbacks.readSecretCoreStorage({ tag: "DeviceEncryptionKey" }),
    ).toEqual(new Uint8Array([1, 2]));
    expect(sharedAuth.storage.size).toBe(0);
  });

  it("As a dotli integrator, the host encrypts persisted allowance key slots", async () => {
    // Given
    const {
      readSecretCoreStorage,
      writeSecretCoreStorage,
      clearSecretCoreStorage,
    } = createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "session-1" },
    } satisfies SecretCoreStorageKey;

    // When
    await writeSecretCoreStorage(key, new Uint8Array([1, 2, 3, 4]));

    // Then
    const storageKey = "dotli:core:allowance-keys:session-1";
    expect(localStorage.getItem(storageKey)).not.toBe("0x01020304");
    expect(Array.from((await readSecretCoreStorage(key)) ?? [])).toEqual([
      1, 2, 3, 4,
    ]);

    // When
    await clearSecretCoreStorage(key);

    // Then
    expect(await readSecretCoreStorage(key)).toBeUndefined();
  });

  it("As a dotli integrator, the host encrypts the owner-bound auto-signing collection", async () => {
    // Given
    const {
      readSecretCoreStorage,
      writeSecretCoreStorage,
      clearSecretCoreStorage,
    } = createSessionStoreAdapters();
    const key = {
      tag: "AutoSigningKeys",
    } satisfies SecretCoreStorageKey;

    // When
    await writeSecretCoreStorage(key, new Uint8Array([5, 6, 7, 8]));

    // Then
    expect(localStorage.length).toBe(1);
    const storageKey = localStorage.key(0);
    expect(storageKey).toBe("dotli:core:auto-signing-keys");
    expect(localStorage.getItem(storageKey ?? "")).toMatch(/^enc1:0x/);
    expect(Array.from((await readSecretCoreStorage(key)) ?? [])).toEqual([
      5, 6, 7, 8,
    ]);

    // When
    await clearSecretCoreStorage(key);

    // Then
    expect(await readSecretCoreStorage(key)).toBeUndefined();
  });

  it("As a dotli integrator, the host never reuses a nonce across allowance key writes", async () => {
    // Given
    const { readSecretCoreStorage, writeSecretCoreStorage } =
      createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "session-1" },
    } satisfies SecretCoreStorageKey;
    const storageKey = "dotli:core:allowance-keys:session-1";

    // When: the same plaintext is written twice
    await writeSecretCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const first = localStorage.getItem(storageKey);
    await writeSecretCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const second = localStorage.getItem(storageKey);

    // Then: the ciphertexts differ (fresh nonce per write) and still decrypt
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(Array.from((await readSecretCoreStorage(key)) ?? [])).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("As a dotli integrator, the host encrypts allowance keys under a non-extractable per-install key", async () => {
    // Given
    const { writeSecretCoreStorage } = createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "session-1" },
    } satisfies SecretCoreStorageKey;

    // When
    await writeSecretCoreStorage(key, new Uint8Array([1, 2, 3, 4]));

    // Then: the encryption key is a random per-install CryptoKey persisted
    // in IndexedDB whose material can never be exported, not something
    // derivable from public bundle data.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dotli-core");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<CryptoKey | undefined>(
      (resolve, reject) => {
        const request = db
          .transaction("keys")
          .objectStore("keys")
          .get("allowance-keys");
        request.onsuccess = () => resolve(request.result as CryptoKey);
        request.onerror = () => reject(request.error);
      },
    );
    db.close();
    expect(stored?.type).toBe("secret");
    expect(stored?.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey("raw", stored as CryptoKey),
    ).rejects.toThrow();
  });

  it("As a dotli integrator, the host rejects plaintext allowance keys without changing them", async () => {
    const { readSecretCoreStorage } = createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "legacy" },
    } satisfies SecretCoreStorageKey;
    const storageKey = "dotli:core:allowance-keys:legacy";
    localStorage.setItem(storageKey, "0x01020304");

    await expect(readSecretCoreStorage(key)).rejects.toThrow(
      "Invalid encrypted secret storage",
    );
    expect(localStorage.getItem(storageKey)).toBe("0x01020304");
  });

  it("As a dotli integrator, the host preserves allowance slots that fail decryption", async () => {
    // Given: an encrypted slot whose ciphertext no longer authenticates —
    // the same shape as a key lost to an IndexedDB wipe or tampered bytes
    const { readSecretCoreStorage, writeSecretCoreStorage } =
      createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "session-1" },
    } satisfies SecretCoreStorageKey;
    const storageKey = "dotli:core:allowance-keys:session-1";
    await writeSecretCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const stored = localStorage.getItem(storageKey) ?? "";
    const flipped = stored.slice(0, -2) + (stored.endsWith("00") ? "ff" : "00");
    localStorage.setItem(storageKey, flipped);

    await expect(readSecretCoreStorage(key)).rejects.toThrow();
    expect(localStorage.getItem(storageKey)).toBe(flipped);
  });

  it("As a dotli integrator, the host rejects corrupt persisted secrets", async () => {
    // Given
    const { readSecretCoreStorage } = createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "corrupt" },
    } satisfies SecretCoreStorageKey;
    localStorage.setItem("dotli:core:allowance-keys:corrupt", "not-hex");

    // When
    const stored = readSecretCoreStorage(key);

    // Then
    await expect(stored).rejects.toThrow();
  });

  it("As a dotli integrator, the host rejects a corrupt shared auth session", async () => {
    // Given
    const { readSecretCoreStorage } = createSessionStoreAdapters();
    sharedAuth.storage.set(STORAGE_KEY, "not-hex");

    // When
    const stored = readSecretCoreStorage(AUTH_SESSION_KEY);

    // Then
    await expect(stored).rejects.toThrow();
  });

  it("orders an abandoned encrypted write before a clear from another adapter", async () => {
    const writer = createSessionStoreAdapters();
    const cleaner = createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "abandoned" },
    } satisfies SecretCoreStorageKey;
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encrypting = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      started();
      await blocked;
      return encrypt(...args);
    });

    const write = writer.writeSecretCoreStorage(key, new Uint8Array([9]));
    await encrypting;
    let cleared = false;
    const clear = cleaner.clearSecretCoreStorage(key).then(() => {
      cleared = true;
    });
    await flushMicrotasks();
    const acknowledgedBeforeWriteSettled = cleared;
    release();
    await Promise.all([write, clear]);

    expect({
      acknowledgedBeforeWriteSettled,
      stored: localStorage.getItem("dotli:core:allowance-keys:abandoned"),
    }).toEqual({ acknowledgedBeforeWriteSettled: false, stored: null });
  });

  it("refuses encrypted writes when persistent key storage is unavailable", async () => {
    vi.resetModules();
    const { createSessionStoreAdapters } =
      await import("@dotli/ui/host-callbacks/SessionStore");
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "bad-key" },
    } satisfies SecretCoreStorageKey;
    vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new Error("key storage unavailable");
    });
    const write = createSessionStoreAdapters().writeSecretCoreStorage(
      key,
      new Uint8Array([9]),
    );
    await expect(write).rejects.toThrow("key storage unavailable");
    expect(
      localStorage.getItem("dotli:core:allowance-keys:bad-key"),
    ).toBeNull();
  });

  it("does not publish ciphertext when the wrapping-key transaction aborts", async () => {
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      ...args
    ) {
      const request = add.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "aborted" },
    } satisfies SecretCoreStorageKey;
    await expect(
      createSessionStoreAdapters().writeSecretCoreStorage(
        key,
        new Uint8Array([9]),
      ),
    ).rejects.toThrow("indexedDB add aborted");
    expect(
      localStorage.getItem("dotli:core:allowance-keys:aborted"),
    ).toBeNull();
  });

  it("rejects a present invalid wrapping key without replacing it", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("dotli-core", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("keys");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("keys", "readwrite");
        transaction.objectStore("keys").put("corrupt", "allowance-keys");
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    await expect(
      createSessionStoreAdapters().writeSecretCoreStorage(
        { tag: "AutoSigningKeys" },
        new Uint8Array([9]),
      ),
    ).rejects.toThrow("Invalid persisted core-secret storage key");
    expect(generate).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("orders public cleanup behind an in-flight secret write", async () => {
    const writer = createSessionStoreAdapters();
    const cleaner = createSessionStoreAdapters();
    const publicKey = {
      tag: "StatementRenewalTargets",
    } satisfies CoreStorageKey;
    await writer.writeCoreStorage(publicKey, new Uint8Array([1]));
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encrypting = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      started();
      await blocked;
      return encrypt(...args);
    });
    const write = writer.writeSecretCoreStorage(
      { tag: "AutoSigningKeys" },
      new Uint8Array([9]),
    );
    await encrypting;
    const clear = cleaner.clearCoreStorage(publicKey);
    await flushMicrotasks();
    const beforeRelease = localStorage.getItem(
      "dotli:core:statement-renewal-targets",
    );
    release();
    await Promise.all([write, clear]);
    expect([
      beforeRelease,
      localStorage.getItem("dotli:core:statement-renewal-targets"),
    ]).toEqual(["0x01", null]);
  });

  it("preserves a shared session when its read fails", async () => {
    sharedAuth.storage.set(STORAGE_KEY, "0x09");
    sharedAuth.readFailure = new Error("shared storage unavailable");
    await expect(
      createSessionStoreAdapters().readSecretCoreStorage(AUTH_SESSION_KEY),
    ).rejects.toThrow("shared storage unavailable");
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBe("0x09");
  });

  it("keeps the installation identity while an explicit secret reset clears corrupt allowances", async () => {
    const callbacks = createSessionStoreAdapters();
    const identity = {
      tag: "PairingDeviceIdentity",
    } satisfies SecretCoreStorageKey;
    const allowances = {
      tag: "AllowanceKeys",
      value: { sessionId: "corrupt-reset" },
    } satisfies SecretCoreStorageKey;
    await callbacks.writeSecretCoreStorage(identity, new Uint8Array([7]));
    localStorage.setItem("dotli:core:allowance-keys:corrupt-reset", "corrupt");
    await expect(callbacks.readSecretCoreStorage(allowances)).rejects.toThrow();
    await callbacks.clearSecretCoreStorage(allowances);
    expect([
      await callbacks.readSecretCoreStorage(identity),
      await callbacks.readSecretCoreStorage(allowances),
      localStorage.getItem("dotli:core:pairing-device-identity"),
    ]).toEqual([new Uint8Array([7]), undefined, "0x07"]);
  });

  it("emits own auth dirty signals before write and clear callbacks resolve", async () => {
    const callbacks = createSessionStoreAdapters();
    const events: string[] = [];
    const unsubscribe = onStoredSessionChanged(() => events.push("dirty"));
    await callbacks
      .writeSecretCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9]))
      .then(() => events.push("written"));
    await callbacks
      .clearSecretCoreStorage(AUTH_SESSION_KEY)
      .then(() => events.push("cleared"));
    unsubscribe();
    expect(events).toEqual(["dirty", "written", "dirty", "cleared"]);
  });

  it("As a dotli integrator, the host emits the typed session identity details from a connected auth state", () => {
    // Given
    const authStateChanged = createAuthStateChanged("Polkadot Web");
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    // When
    authStateChanged?.({
      tag: "Connected",
      value: connectedSessionUiInfo(),
    });

    // Then
    expect(events).toEqual([{ tag: "Connected", session: CONNECTED_DETAIL }]);
  });

  it("As a dotli integrator, the host dispatches the pairing presentation with its host context", () => {
    // Given
    const authStateChanged = createAuthStateChanged("Polkadot Web", {
      dotSuffix: false,
      hostGlobal: true,
    });
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    // When
    authStateChanged?.({
      tag: "Pairing",
      value: { deeplink: "polkadotapp://pair?handshake=test" },
    });

    // Then
    expect(events).toEqual([
      {
        tag: "Pairing",
        deeplink: "polkadotapp://pair?handshake=test",
        label: "Polkadot Web",
        dotSuffix: false,
        hostGlobal: true,
      },
    ]);
  });

  it("As a dotli integrator, the host dispatches the authenticating state", () => {
    // Given
    const authStateChanged = createAuthStateChanged("Polkadot Web");
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    // When
    authStateChanged?.({ tag: "Authenticating" });

    // Then
    expect(events).toEqual([{ tag: "Authenticating" }]);
  });

  it("As a dotli integrator, the host caches the connected UI state and clears it with the session", async () => {
    // Given
    const authStateChanged = createAuthStateChanged("Polkadot Web");
    const { clearSecretCoreStorage } = createSessionStoreAdapters();

    // When
    authStateChanged?.({
      tag: "Connected",
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();

    // Then
    expect(
      JSON.parse(sharedAuth.storage.get(UI_STATE_CACHE_KEY) ?? ""),
    ).toEqual(CONNECTED_DETAIL);

    // When
    await clearSecretCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it("As a dotli integrator, the host clears the cached UI state on a disconnected auth state", async () => {
    // Given
    const authStateChanged = createAuthStateChanged("Polkadot Web");

    authStateChanged?.({
      tag: "Connected",
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeDefined();

    // When
    authStateChanged?.({ tag: "Disconnected" });
    await flushMicrotasks();

    // Then
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it("As a dotli integrator, the host rehydrates the cached session UI state", async () => {
    // Given
    const authStateChanged = createAuthStateChanged("Polkadot Web");
    const { writeSecretCoreStorage } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    // Nothing persisted: nothing emitted, even with a stale cache entry.
    sharedAuth.storage.set(
      UI_STATE_CACHE_KEY,
      JSON.stringify(CONNECTED_DETAIL),
    );
    emitPersistedSessionUiState();
    await flushMicrotasks();
    expect(events).toEqual([]);
    sharedAuth.storage.delete(UI_STATE_CACHE_KEY);

    // When
    await writeSecretCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    authStateChanged?.({
      tag: "Connected",
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    events.length = 0;

    emitPersistedSessionUiState();
    await flushMicrotasks();

    // Then
    expect(events).toEqual([{ tag: "Connected", session: CONNECTED_DETAIL }]);
  });

  it("As a dotli integrator, the host rehydrates a bare connected state when no cache exists", async () => {
    // Given
    const { writeSecretCoreStorage } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    // When
    await writeSecretCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    emitPersistedSessionUiState();
    await flushMicrotasks();

    // Then
    expect(events).toEqual([
      { tag: "Connected", session: { connected: true } },
    ]);
  });

  it("As a dotli integrator, the host degrades to a bare connected state when the cached UI state is malformed", async () => {
    // Given: a persisted session, but a UI-state cache whose fields no longer
    // match the expected shape (e.g. written by a different code version).
    const { writeSecretCoreStorage } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });
    await writeSecretCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    sharedAuth.storage.set(
      UI_STATE_CACHE_KEY,
      JSON.stringify({ connected: true, publicKey: 42, liteUsername: null }),
    );

    // When
    emitPersistedSessionUiState();
    await flushMicrotasks();

    // Then: the malformed cache is discarded instead of being laundered into
    // a typed session state with non-string fields.
    expect(events).toEqual([
      { tag: "Connected", session: { connected: true } },
    ]);
  });

  it("As a dotli integrator, the host notifies local and matching storage changes", async () => {
    // Given
    const { writeSecretCoreStorage } = createSessionStoreAdapters();
    const listener = vi.fn();
    const unsubscribe = onStoredSessionChanged(listener);

    // When
    await writeSecretCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9]));

    // Then
    expect(listener).toHaveBeenCalledTimes(1);

    // When
    for (const sharedListener of sharedAuth.listeners) {
      sharedListener({
        siteId: SITE_ID,
        key: SHARED_CORE_SESSION_KEY,
        value: "0x09",
      });
    }

    // Then
    expect(listener).toHaveBeenCalledTimes(2);

    // When
    unsubscribe();
    await writeSecretCoreStorage(AUTH_SESSION_KEY, new Uint8Array([8]));

    // Then
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
