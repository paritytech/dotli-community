// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { CoreCustodyOperation } from "@dotli/protocol/core-custody";
import { withSharedWalletRevision } from "./wallet-storage";

export const CORE_CUSTODY_DB_NAME = "dotli-native-core-custody";
const STORE = "records";
const KEY = "encryption-key";
let lease: { token: string; revision: string | null; released: Promise<void>; release(): void } | undefined;
let acquiring = false;
let pageActive = true;
let pageLifetime = 0;

// A lease belongs to this host iframe's parent, not to a product or a TTL.
// Page destruction releases Web Locks even if JavaScript never runs cleanup.
window.addEventListener("pagehide", () => {
  pageActive = false;
  pageLifetime++;
  lease?.release();
  lease = undefined;
});
window.addEventListener("pageshow", () => { pageActive = true; });

async function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(CORE_CUSTODY_DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  let blocked = false;
  request.onblocked = () => { blocked = true; reject(new Error("Private custody storage is blocked")); };
  request.onerror = () => reject(new Error("Private custody storage is unavailable"));
  request.onsuccess = () => {
    if (blocked) { request.result.close(); return; }
    resolve(request.result);
  };
  return promise;
}

function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const tx = db.transaction(STORE, mode, { durability: "strict" });
  let request: IDBRequest<T>;
  tx.oncomplete = () => resolve(request.result);
  tx.onerror = tx.onabort = () => reject(new Error("Private custody transaction failed"));
  try { request = action(tx.objectStore(STORE)); } catch (error) { tx.abort(); reject(error); }
  return promise;
}

export async function handleCoreCustody(operation: CoreCustodyOperation, deadlineMs?: number): Promise<string | Uint8Array | Blob | undefined> {
  if (operation.action === "acquire") {
    if (!pageActive) throw new Error("Private custody host is inactive");
    if (!navigator.locks || !crypto.subtle || !globalThis.indexedDB) throw new Error("Private custody requires Web Locks, Web Crypto and IndexedDB");
    if (lease || acquiring) throw new Error("A signing runtime already owns this wallet in this page");
    acquiring = true;
    const lifetime = pageLifetime;
    const ready = Promise.withResolvers<string>();
    const released = Promise.withResolvers<void>();
    void navigator.locks.request("dotli:native-core-custody", { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("The test wallet is active in another tab. Close it before opening it here.");
      const held = Promise.withResolvers<void>();
      await withSharedWalletRevision(operation.walletRevision, async () => {
        // Check durable storage before giving any runtime custody authority.
        const db = await openDatabase();
        db.close();
        if (!pageActive || lifetime !== pageLifetime) throw new Error("Private custody host closed while acquiring custody");
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw new Error("Private custody request expired");
        const token = crypto.randomUUID();
        lease = { token, revision: operation.walletRevision, released: released.promise, release: () => held.resolve() };
        ready.resolve(token);
      }, deadlineMs);
      await held.promise;
    }).catch((error: unknown) => ready.reject(error)).finally(() => { acquiring = false; released.resolve(); });
    try { return await ready.promise; } catch (error) { acquiring = false; throw error; }
  }
  const owner = lease;
  if (!owner || operation.lease !== owner.token) throw new Error("Private custody lease is unavailable");
  if (operation.action === "release") {
    lease = undefined;
    owner.release();
    await owner.released;
    return;
  }
  let result: Uint8Array | Blob | undefined;
  await withSharedWalletRevision(owner.revision, async () => {
    if (lease !== owner) throw new Error("Private custody lease changed");
    const db = await openDatabase();
    try {
      if (operation.action === "putSources") {
        // IndexedDB commits immutable Blob snapshots without materializing an
        // entire attachment as a JavaScript byte array. No names or paths persist.
        await transaction(db, "readwrite", (store) => {
          let last: IDBRequest<IDBValidKey> | undefined;
          for (const source of operation.sources) {
            last = store.add(source.blob.slice(0, source.blob.size, "application/octet-stream"), `source:${source.sourceId}`);
          }
          if (!last) throw new Error("No Chat sources supplied");
          return last;
        });
        return;
      }
      if (operation.action === "readSource") {
        const blob: unknown = await transaction(db, "readonly", (store) => store.get(`source:${operation.sourceId}`));
        if (blob !== undefined && !(blob instanceof Blob)) throw new Error("Private Chat source is corrupt");
        result = blob;
        return;
      }
      if (operation.action === "releaseSource") {
        await transaction(db, "readwrite", (store) => store.delete(`source:${operation.sourceId}`));
        return;
      }
      const storageKey = `core:${operation.key}`;
      if (operation.action === "clear") {
        await transaction(db, "readwrite", (store) => store.delete(storageKey));
        return;
      }
      const storedKey: unknown = await transaction(db, "readonly", (store) => store.get(KEY));
      const stored: unknown = operation.action === "read"
        ? await transaction(db, "readonly", (store) => store.get(storageKey))
        : undefined;
      if (operation.action === "read" && stored === undefined) return;
      let key: CryptoKey;
      if (storedKey === undefined) {
        if (operation.action === "read") throw new Error("Private custody encryption key is missing");
        const existing = await transaction(db, "readonly", (store) => store.count(IDBKeyRange.bound("core:", "core;")));
        if (existing > 0) throw new Error("Private custody encryption key is missing");
        key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        await transaction(db, "readwrite", (store) => store.add(key, KEY));
      } else {
        if (
          typeof storedKey !== "object" || storedKey === null ||
          (storedKey as CryptoKey).type !== "secret" ||
          (storedKey as CryptoKey).algorithm?.name !== "AES-GCM" ||
          (storedKey as CryptoKey).extractable !== false
        ) throw new Error("Private custody encryption key is invalid");
        key = storedKey as CryptoKey;
      }
      const additionalData = new TextEncoder().encode(storageKey);
      if (operation.action === "read") {
        if (!(stored instanceof Uint8Array) || stored.length < 28) throw new Error("Private custody record is corrupt");
        // Failure is not absence: never delete/recreate an undecryptable purse or device.
        result = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(stored.subarray(0, 12)), additionalData }, key, new Uint8Array(stored.subarray(12))));
      } else {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, new Uint8Array(operation.value)));
        const record = new Uint8Array(iv.length + ciphertext.length);
        record.set(iv);
        record.set(ciphertext, iv.length);
        if (lease !== owner) throw new Error("Private custody lease changed");
        await transaction(db, "readwrite", (store) => store.put(record, storageKey));
      }
    } finally { db.close(); }
  }, deadlineMs);
  return result;
}
