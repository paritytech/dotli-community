import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSharedAuthStorageKey,
  SHARED_CORE_SESSION_KEY,
} from "@dotli/protocol/auth-storage";
import { SITE_ID } from "@dotli/config/config";
import { createSessionStoreAdapters } from "@dotli/ui/host-callbacks/SessionStore";

const STORAGE_KEY = buildSharedAuthStorageKey(SITE_ID, SHARED_CORE_SESSION_KEY);

const enc = new TextEncoder();

function compactLength(length: number): number[] {
  if (length < 64) {
    return [length << 2];
  }
  throw new Error("test helper only supports compact single-byte lengths");
}

function optionString(value: string | undefined): number[] {
  if (value === undefined) {
    return [0];
  }
  const bytes = Array.from(enc.encode(value));
  return [1, ...compactLength(bytes.length), ...bytes];
}

function optionFixed(value: number[] | undefined): number[] {
  return value === undefined ? [0] : [1, ...value];
}

function sessionBlobV3(): Uint8Array {
  const publicKey = Array.from({ length: 32 }, (_, i) => i);
  const identityAccountId = Array.from({ length: 32 }, (_, i) => 0xa0 + i);
  return new Uint8Array([
    3,
    ...publicKey,
    0,
    ...optionFixed(undefined),
    ...optionFixed(identityAccountId),
    ...optionString("pgherveou.04"),
    ...optionString(undefined),
  ]);
}

describe("session-store host callbacks", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips the host core session blob", async () => {
    const { readSession, writeSession, clearSession } =
      createSessionStoreAdapters();

    expect(await readSession()).toBeUndefined();

    await writeSession(new Uint8Array([1, 2, 3]));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("0x010203");
    expect(Array.from((await readSession()) ?? [])).toEqual([1, 2, 3]);

    await clearSession();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await readSession()).toBeUndefined();
  });

  it("emits decoded connected session identity details", async () => {
    const { writeSession } = createSessionStoreAdapters();
    const events: unknown[] = [];
    window.addEventListener("dotli:truapi-session-state", (event) => {
      events.push((event as CustomEvent).detail);
    });

    await writeSession(sessionBlobV3());

    expect(events).toEqual([
      {
        connected: true,
        publicKey:
          "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        identityAccountId:
          "0xa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf",
        liteUsername: "pgherveou.04",
        primaryUsername: "pgherveou.04",
      },
    ]);
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
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    const remoteTick = await remote;
    expect(remoteTick.done).toBe(false);
    expect(remoteTick.value.isOk()).toBe(true);

    await iterator.return?.();
  });
});
