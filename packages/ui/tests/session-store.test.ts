import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import { SITE_ID } from "@dotli/config/config";
import {
  createSessionStoreAdapters,
  emitPersistedSessionUiState,
  emitSessionConnectionState,
} from "@dotli/ui/host-callbacks/SessionStore";

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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function connectedSessionUiInfo() {
  return {
    connected: true,
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
    emitSessionConnectionState(false);
  });

  it("round-trips the host core session blob", async () => {
    const { readSession, writeSession, clearSession } =
      createSessionStoreAdapters();

    expect(await readSession()).toBeUndefined();

    await writeSession(new Uint8Array([1, 2, 3]));
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBe("0x010203");
    expect(localStorage.length).toBe(0);
    expect(Array.from((await readSession()) ?? [])).toEqual([1, 2, 3]);

    await clearSession();
    expect(sharedAuth.storage.get(STORAGE_KEY)).toBeUndefined();
    expect(await readSession()).toBeUndefined();
  });

  it("emits the typed session identity details from sessionUiChanged", () => {
    const { sessionUiChanged } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-session-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    sessionUiChanged?.(connectedSessionUiInfo());

    expect(events).toEqual([CONNECTED_DETAIL]);
  });

  it("caches the connected UI state and clears it with the session", async () => {
    const { sessionUiChanged, clearSession } = createSessionStoreAdapters();

    sessionUiChanged?.(connectedSessionUiInfo());
    await flushMicrotasks();
    expect(JSON.parse(sharedAuth.storage.get(UI_STATE_CACHE_KEY) ?? "")).toEqual(
      CONNECTED_DETAIL,
    );

    await clearSession();
    expect(sharedAuth.storage.get(UI_STATE_CACHE_KEY)).toBeUndefined();
  });

  it("does not downgrade a richer connected state with a bare one", () => {
    const { sessionUiChanged } = createSessionStoreAdapters();
    const events: { connected: boolean; liteUsername?: string }[] = [];
    window.addEventListener("dotli:truapi-session-state", (event) => {
      events.push(
        (event as CustomEvent<{ connected: boolean; liteUsername?: string }>)
          .detail,
      );
    });

    // The core emits the rich state, then the bridge's post-login bare
    // dispatch must not clobber it.
    sessionUiChanged?.(connectedSessionUiInfo());
    emitSessionConnectionState(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      connected: true,
      liteUsername: "pgherveou.04",
    });

    // Disconnect resets the guard, after which bare events flow again.
    emitSessionConnectionState(false);
    emitSessionConnectionState(true);
    expect(events.slice(1)).toEqual([{ connected: false }, { connected: true }]);
  });

  it("rehydrates the cached session UI state", async () => {
    const { writeSession, sessionUiChanged } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-session-state", (event) => {
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

    await writeSession(new Uint8Array([1, 2, 3]));
    sessionUiChanged?.(connectedSessionUiInfo());
    await flushMicrotasks();
    events.length = 0;

    emitPersistedSessionUiState();
    await flushMicrotasks();
    expect(events).toEqual([CONNECTED_DETAIL]);
  });

  it("rehydrates a bare connected state when no cache exists", async () => {
    const { writeSession } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-session-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    await writeSession(new Uint8Array([1, 2, 3]));
    emitPersistedSessionUiState();
    await flushMicrotasks();

    expect(events).toEqual([{ connected: true }]);
  });

  it("emits current, local, and matching storage change ticks", async () => {
    const { subscribeSessionStore, writeSession } =
      createSessionStoreAdapters();
    const iterator = subscribeSessionStore()[Symbol.asyncIterator]();

    const initial = await iterator.next();
    expect(initial.done).toBe(false);
    expect(initial.value.isOk()).toBe(true);

    const local = iterator.next();
    await writeSession(new Uint8Array([9]));
    const localTick = await local;
    expect(localTick.done).toBe(false);
    expect(localTick.value.isOk()).toBe(true);

    const remote = iterator.next();
    for (const listener of sharedAuth.listeners) {
      listener({
        siteId: SITE_ID,
        key: SHARED_CORE_SESSION_KEY,
        value: "0x09",
      });
    }
    const remoteTick = await remote;
    expect(remoteTick.done).toBe(false);
    expect(remoteTick.value.isOk()).toBe(true);

    await iterator.return?.();
  });
});
