import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import { SITE_ID } from "@dotli/config/config";
import {
  createSessionStoreAdapters,
  emitPersistedSessionUiState,
  onStoredSessionChanged,
} from "@dotli/ui/host-callbacks/SessionStore";
import { createAuthStateChanged } from "@dotli/ui/host-callbacks/AuthState";

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

  it("round-trips the host core session blob", async () => {
    const { readCoreStorage, writeCoreStorage, clearCoreStorage } =
      createSessionStoreAdapters();

    expect(await readCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();

    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBe("0x010203");
    expect(localStorage.length).toBe(0);
    expect(Array.from((await readCoreStorage(AUTH_SESSION_KEY)) ?? [])).toEqual(
      [1, 2, 3],
    );

    await clearCoreStorage(AUTH_SESSION_KEY);
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBeUndefined();
    expect(await readCoreStorage(AUTH_SESSION_KEY)).toBeUndefined();
  });

  it("emits the typed session identity details from a connected auth state", () => {
    const authStateChanged = createAuthStateChanged("Polkadot Web");
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    authStateChanged?.({
      tag: "Connected",
      value: connectedSessionUiInfo(),
    });

    expect(events).toEqual([{ tag: "Connected", session: CONNECTED_DETAIL }]);
  });

  it("dispatches the pairing presentation with its host context", () => {
    const authStateChanged = createAuthStateChanged("Polkadot Web", {
      dotSuffix: false,
      hostGlobal: true,
    });
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    authStateChanged?.({
      tag: "Pairing",
      value: { deeplink: "polkadotapp://pair?handshake=test" },
    });

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

  it("caches the connected UI state and clears it with the session", async () => {
    const authStateChanged = createAuthStateChanged("Polkadot Web");
    const { clearCoreStorage } = createSessionStoreAdapters();

    authStateChanged?.({
      tag: "Connected",
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    expect(
      JSON.parse(sharedAuth.storage.get(UI_STATE_CACHE_KEY) ?? ""),
    ).toEqual(CONNECTED_DETAIL);

    await clearCoreStorage(AUTH_SESSION_KEY);
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it("clears the cached UI state on a disconnected auth state", async () => {
    const authStateChanged = createAuthStateChanged("Polkadot Web");

    authStateChanged?.({
      tag: "Connected",
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeDefined();

    authStateChanged?.({ tag: "Disconnected" });
    await flushMicrotasks();
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it("rehydrates the cached session UI state", async () => {
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

    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    authStateChanged?.({
      tag: "Connected",
      value: connectedSessionUiInfo(),
    });
    await flushMicrotasks();
    events.length = 0;

    emitPersistedSessionUiState();
    await flushMicrotasks();
    expect(events).toEqual([{ tag: "Connected", session: CONNECTED_DETAIL }]);
  });

  it("rehydrates a bare connected state when no cache exists", async () => {
    const { writeCoreStorage } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-auth-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([1, 2, 3]));
    emitPersistedSessionUiState();
    await flushMicrotasks();

    expect(events).toEqual([
      { tag: "Connected", session: { connected: true } },
    ]);
  });

  it("notifies local and matching storage changes", async () => {
    const { writeCoreStorage } = createSessionStoreAdapters();
    const listener = vi.fn();
    const unsubscribe = onStoredSessionChanged(listener);

    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([9]));
    expect(listener).toHaveBeenCalledTimes(1);

    for (const sharedListener of sharedAuth.listeners) {
      sharedListener({
        siteId: SITE_ID,
        key: SHARED_CORE_SESSION_KEY,
        value: "0x09",
      });
    }
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await writeCoreStorage(AUTH_SESSION_KEY, new Uint8Array([8]));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
