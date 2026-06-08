import { beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_ID } from "@dotli/config/config";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import { createSessionStoreAdapters } from "@dotli/ui/host-callbacks/SessionStore";

interface StorageChange {
  siteId: string;
  key: string;
  value: string | null;
}

const protocol = vi.hoisted(() => {
  const listeners = new Set<(change: StorageChange) => void>();
  return {
    value: null as string | null,
    listeners,
    readSharedAuthStorage: vi.fn(async () => protocol.value),
    writeSharedAuthStorage: vi.fn(async (_siteId, _key, value: string) => {
      protocol.value = value;
    }),
    clearSharedAuthStorage: vi.fn(async () => {
      protocol.value = null;
    }),
    subscribeSharedAuthStorage: vi.fn(
      (listener: (change: StorageChange) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    ),
    emit(change: StorageChange) {
      for (const listener of listeners) {
        listener(change);
      }
    },
  };
});

vi.mock("@dotli/protocol/client", () => ({
  readSharedAuthStorage: protocol.readSharedAuthStorage,
  writeSharedAuthStorage: protocol.writeSharedAuthStorage,
  clearSharedAuthStorage: protocol.clearSharedAuthStorage,
  subscribeSharedAuthStorage: protocol.subscribeSharedAuthStorage,
}));

describe("session-store host callbacks", () => {
  beforeEach(() => {
    protocol.value = null;
    protocol.listeners.clear();
    protocol.readSharedAuthStorage.mockClear();
    protocol.writeSharedAuthStorage.mockClear();
    protocol.clearSharedAuthStorage.mockClear();
    protocol.subscribeSharedAuthStorage.mockClear();
  });

  it("round-trips the shared core session blob", async () => {
    const { readSession, writeSession, clearSession } =
      createSessionStoreAdapters();

    expect(await readSession()).toBeUndefined();

    await writeSession(new Uint8Array([1, 2, 3]));
    expect(protocol.writeSharedAuthStorage).toHaveBeenCalledWith(
      SITE_ID,
      SHARED_CORE_SESSION_KEY,
      "0x010203",
    );
    expect(Array.from((await readSession()) ?? [])).toEqual([1, 2, 3]);

    await clearSession();
    expect(protocol.clearSharedAuthStorage).toHaveBeenCalledWith(
      SITE_ID,
      SHARED_CORE_SESSION_KEY,
    );
    expect(await readSession()).toBeUndefined();
  });

  it("emits current, local, and matching remote change ticks", async () => {
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
    protocol.emit({
      siteId: SITE_ID,
      key: SHARED_CORE_SESSION_KEY,
      value: null,
    });
    const remoteTick = await remote;
    expect(remoteTick.done).toBe(false);
    expect(remoteTick.value.isOk()).toBe(true);

    await iterator.return?.();
    expect(protocol.listeners.size).toBe(0);
  });
});
