// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  SharedWalletOperation,
  SharedWalletResult,
  SharedWalletState,
} from "@dotli/protocol/wallet-storage";

export const WALLET_DB_NAME = "dotli-wallet";
const STORE = "wallet";
const SLOT = "state-v1";
const LOCK = "dotli:shared-wallet-v1";
const NONCE_LENGTH = 12;

interface WalletRecord {
  version: number;
  revision: string;
  enabled: boolean;
  // One atomic IDB record ties the non-extractable key to its ciphertext.
  key?: CryptoKey;
  encrypted?: Uint8Array<ArrayBuffer>;
}

function openDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(WALLET_DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () =>
    reject(request.error ?? new Error("Wallet database unavailable"));
  return promise;
}

function readRecord(db: IDBDatabase): Promise<WalletRecord | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<
    WalletRecord | undefined
  >();
  const tx = db.transaction(STORE);
  const request = tx.objectStore(STORE).get(SLOT);
  tx.oncomplete = () => resolve(request.result as WalletRecord | undefined);
  tx.onabort = tx.onerror = () =>
    reject(tx.error ?? new Error("Wallet read failed"));
  return promise;
}

/** The lock covers crypto awaits; the transaction makes key/ciphertext/state durable together. */
function writeRecord(db: IDBDatabase, record: WalletRecord): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(record, SLOT);
  tx.oncomplete = () => resolve();
  tx.onabort = tx.onerror = () =>
    reject(tx.error ?? new Error("Wallet write failed"));
  return promise;
}

function stateOf(record: WalletRecord | undefined): SharedWalletState {
  return {
    version: record?.version ?? 0,
    revision: record?.revision ?? null,
    enabled: record?.enabled ?? false,
    hasWallet: record?.encrypted !== undefined,
  };
}

async function decrypt(
  record: WalletRecord | undefined,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (record?.encrypted === undefined) return undefined;
  if (
    record.key === undefined ||
    record.key.extractable ||
    record.key.algorithm.name !== "AES-GCM"
  ) {
    throw new Error(
      "Stored wallet key is invalid; wallet has been preserved for recovery",
    );
  }
  const secret = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.encrypted.slice(0, NONCE_LENGTH) },
      record.key,
      record.encrypted.slice(NONCE_LENGTH),
    ),
  );
  if (!validEntropy(secret)) {
    secret.fill(0);
    throw new Error(
      "Stored wallet entropy is invalid; wallet has been preserved for recovery",
    );
  }
  return secret;
}

function validEntropy(secret: unknown): boolean {
  return (
    secret instanceof Uint8Array &&
    secret.length >= 16 &&
    secret.length <= 32 &&
    secret.length % 4 === 0
  );
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "WalletConflictError";
  return error;
}

export async function handleWalletOperation(
  operation: SharedWalletOperation,
  changed: (state: SharedWalletState) => void,
  deadlineMs?: number,
): Promise<SharedWalletResult> {
  if (!navigator.locks || !crypto.subtle) {
    throw new Error(
      "Shared wallets require secure-context Web Locks, Web Crypto and IndexedDB",
    );
  }
  return navigator.locks.request(LOCK, async () => {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs)
      throw new Error("Wallet request expired");
    const db = await openDb();
    try {
      const record = await readRecord(db);
      const state = stateOf(record);
      if (operation.action === "state") return { state };
      if (operation.action === "read")
        return { state, secret: await decrypt(record) };
      if (
        !Number.isSafeInteger(operation.expectedVersion) ||
        operation.expectedVersion !== state.version
      ) {
        throw conflict(
          "Wallet changed in another tab. Reload and retry this operation.",
        );
      }
      if (operation.action === "create" && state.hasWallet) {
        return { state, secret: await decrypt(record), created: false };
      }
      if (operation.action === "migrate" || operation.action === "import") {
        if (!validEntropy(operation.secret))
          throw new Error("Invalid wallet entropy");
      }
      if (operation.action === "migrate" && record !== undefined) {
        const existing = await decrypt(record);
        try {
          if (
            existing !== undefined &&
            existing.length === operation.secret.length &&
            existing.every((byte, index) => byte === operation.secret[index])
          )
            return { state };
          throw conflict(
            "This origin has a different saved wallet, or the shared wallet was deleted. Export the preserved local recovery phrase, then explicitly import it to replace the shared wallet. Delete permanently removes both the shared wallet and this origin's saved copy.",
          );
        } finally {
          existing?.fill(0);
        }
      }
      if (operation.action === "enabled") {
        if (typeof operation.enabled !== "boolean")
          throw new Error("Invalid wallet mode");
        if (operation.enabled && !state.hasWallet)
          throw new Error("Create or import a wallet before enabling Lite");
        if (state.enabled === operation.enabled) return { state };
      }
      if (state.version === Number.MAX_SAFE_INTEGER)
        throw new Error("Wallet revision exhausted");
      let next: WalletRecord;
      let secret: Uint8Array<ArrayBuffer> | undefined;
      if (operation.action === "enabled") {
        // Enabling does not change the identity/grant revision.
        next = {
          ...record!,
          version: state.version + 1,
          enabled: operation.enabled,
        };
      } else if (operation.action === "delete") {
        // Keep a tombstone forever: a stale origin-local copy cannot resurrect it.
        next = {
          version: state.version + 1,
          revision: crypto.randomUUID(),
          enabled: false,
        };
      } else if (
        operation.action === "create" ||
        operation.action === "import" ||
        operation.action === "migrate"
      ) {
        secret =
          operation.action === "create"
            ? crypto.getRandomValues(new Uint8Array(32))
            : operation.secret.slice();
        try {
          const key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
          const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
          const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-GCM", iv: nonce },
              key,
              secret,
            ),
          );
          const encrypted = new Uint8Array(nonce.length + ciphertext.length);
          encrypted.set(nonce);
          encrypted.set(ciphertext, nonce.length);
          next = {
            version: state.version + 1,
            revision: crypto.randomUUID(),
            enabled:
              operation.action === "migrate"
                ? operation.enabled === true
                : state.enabled,
            key,
            encrypted,
          };
        } catch (error) {
          secret.fill(0);
          throw error;
        }
      } else {
        throw new Error("Invalid wallet operation");
      }
      let returnedSecret = false;
      try {
        if (deadlineMs !== undefined && Date.now() >= deadlineMs)
          throw new Error("Wallet request expired");
        await writeRecord(db, next);
        const nextState = stateOf(next);
        changed(nextState);
        returnedSecret = operation.action === "create";
        return {
          state: nextState,
          ...(operation.action === "create" ? { secret, created: true } : {}),
        };
      } finally {
        if (!returnedSecret) secret?.fill(0);
      }
    } finally {
      db.close();
      if (
        (operation.action === "import" || operation.action === "migrate") &&
        operation.secret instanceof Uint8Array
      )
        operation.secret.fill(0);
    }
  });
}

/** Serialize verified-public-metadata writes with identity replacement/deletion. */
export async function withSharedWalletRevision(
  revision: string | null,
  commit: () => void,
  deadlineMs?: number,
): Promise<void> {
  if (!navigator.locks)
    throw new Error("Shared wallets require secure-context Web Locks");
  await navigator.locks.request(LOCK, async () => {
    const db = await openDb();
    try {
      const record = await readRecord(db);
      if (deadlineMs !== undefined && Date.now() >= deadlineMs)
        throw new Error("Wallet request expired");
      if (
        record === undefined ||
        !record.enabled ||
        record.encrypted === undefined ||
        record.revision !== revision
      ) {
        throw conflict("Wallet changed while saving its verified identity.");
      }
      commit();
    } finally {
      db.close();
    }
  });
}
