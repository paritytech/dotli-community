import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import { SITE_ID } from "@dotli/config/config";
import {
  createSessionStoreAdapters,
  emitPersistedSessionUiState,
  onStoredSessionChanged,
} from "@dotli/ui/host-callbacks/SessionStore";
import { createAuthStateChanged } from "@dotli/ui/host-callbacks/AuthState";
import type { CoreStorageKey } from "@parity/truapi-host";

const sharedAuth = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  listeners: new Set<
    (change: { siteId: string; key: string; value: string | null }) => void
  >(),
}));

vi.mock("@dotli/protocol/client", () => ({
  readSharedAuthStorage: async (siteId: string, key: string) => {
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

function connectedSessionUiInfo() {
  return {
    publicKey: new Uint8Array(Array.from({ length: 32 }, (_, i) => i)),
    identityAccountId: new Uint8Array(
      Array.from({ length: 32 }, (_, i) => 0xa0 + i),
    ),
    liteUsername: "pgherveou.04",
  };
}

const CONNECTED_DETAIL = {
  connected: true,
  publicKey:
    "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  identityAccountId:
    "0xa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf",
  liteUsername: "pgherveou.04",
  primaryUsername: "pgherveou.04",
};

describe("session-store host callbacks", () => {
  beforeEach(() => {
    localStorage.clear();
    sharedAuth.storage.clear();
    sharedAuth.listeners.clear();
    vi.restoreAllMocks();
  });

  it("As a dotli integrator, the host round-trips the host core session blob", async () => {
    // Given
    const { readCoreStorage, writeCoreStorage, clearCoreStorage } =
      createSessionStoreAdapters();

    expect(await readCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();

    // When
    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));

    // Then
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBe("0x010203");
    expect(localStorage.length).toBe(0);
    expect(Array.from((await readCoreStorage(AUTH_SESSION_KEY)) ?? [])).toEqual(
      [1, 2, 3],
    );

    // When
    await clearCoreStorage(AUTH_SESSION_KEY);

    // Then
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBeUndefined();
    expect(await readCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();
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

  it("As a dotli integrator, the host encrypts persisted allowance key slots", async () => {
    // Given
    const { readCoreStorage, writeCoreStorage, clearCoreStorage } =
      createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "session-1" },
    } satisfies CoreStorageKey;

    // When
    await writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));

    // Then
    const storageKey = "dotli:core:allowance-keys:session-1";
    expect(localStorage.getItem(storageKey)).not.toBe("0x01020304");
    expect(Array.from((await readCoreStorage(key)) ?? [])).toEqual([
      1, 2, 3, 4,
    ]);

    // When
    await clearCoreStorage(key);

    // Then
    expect(await readCoreStorage(key)).toBeUndefined();
  });

  it("As a dotli integrator, the host never reuses a nonce across allowance key writes", async () => {
    // Given
    const { readCoreStorage, writeCoreStorage } = createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "session-1" },
    } satisfies CoreStorageKey;
    const storageKey = "dotli:core:allowance-keys:session-1";

    // When: the same plaintext is written twice
    await writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const first = localStorage.getItem(storageKey);
    await writeCoreStorage(key, new Uint8Array([1, 2, 3, 4]));
    const second = localStorage.getItem(storageKey);

    // Then: the ciphertexts differ (fresh nonce per write) and still decrypt
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(Array.from((await readCoreStorage(key)) ?? [])).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("As a dotli integrator, the host migrates legacy plaintext allowance keys on read", async () => {
    // Given: a plain-hex slot written before at-rest encryption shipped
    const { readCoreStorage } = createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "legacy" },
    } satisfies CoreStorageKey;
    const storageKey = "dotli:core:allowance-keys:legacy";
    localStorage.setItem(storageKey, "0x01020304");

    // When
    const bytes = await readCoreStorage(key);

    // Then: the legacy bytes are readable and re-persisted encrypted
    expect(Array.from(bytes ?? [])).toEqual([1, 2, 3, 4]);
    expect(localStorage.getItem(storageKey)).not.toBe("0x01020304");
    expect(Array.from((await readCoreStorage(key)) ?? [])).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("As a dotli integrator, the host treats corrupt persisted core bytes as a cache miss", async () => {
    // Given
    const { readCoreStorage } = createSessionStoreAdapters();
    const key = {
      tag: "AllowanceKeys",
      value: { sessionId: "corrupt" },
    } satisfies CoreStorageKey;
    localStorage.setItem("dotli:core:allowance-keys:corrupt", "not-hex");

    // When
    const stored = readCoreStorage(key);

    // Then
    await expect(stored).resolves.toBeUndefined();
  });

  it("As a dotli integrator, the host treats a corrupt shared auth session as a cache miss", async () => {
    // Given
    const { readCoreStorage } = createSessionStoreAdapters();
    sharedAuth.storage.set(STORAGE_KEY, "not-hex");

    // When
    const stored = readCoreStorage(AUTH_SESSION_KEY);

    // Then
    await expect(stored).resolves.toBeUndefined();
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
    const { clearCoreStorage } = createSessionStoreAdapters();

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
    await clearCoreStorage(AUTH_SESSION_KEY);

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
    const { writeCoreStorage } = createSessionStoreAdapters();
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
    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
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
    const { writeCoreStorage } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    // When
    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
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
    const { writeCoreStorage } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });
    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
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
    const { writeCoreStorage } = createSessionStoreAdapters();
    const listener = vi.fn();
    const unsubscribe = onStoredSessionChanged(listener);

    // When
    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9]));

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
    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([8]));

    // Then
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
