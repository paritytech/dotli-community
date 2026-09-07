import { SITE_ID } from "@dotli/config/config";
import { bytesToHex, hexToBytes } from "@parity/truapi/scale";
import { encodeCoreStorageKey } from "@parity/truapi-host";
import type {
  CoreStorage,
  CoreStorageKey,
  SessionUiInfo,
} from "@parity/truapi-host";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import {
  clearSharedAuthStorage,
  readSharedAuthStorage,
  subscribeSharedAuthStorage,
  writeSharedAuthStorage,
} from "@dotli/protocol/client";
import { log } from "@dotli/shared/log";
import { dispatchAuthState } from "./AuthState";

const LOCAL_CHANGE_EVENT = "dotli:truapi-session-store-changed";
const CORE_LOCAL_STORAGE_PREFIX = "dotli:core:";

// JSON cache of the last connected UI state the core reported via
// `authStateChanged`. Lives in shared auth storage next to the opaque
// root-domain session blob so boot-time rehydration never has to decode the
// blob itself.
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;

function emitLocalChange(): void {
  window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
}

export interface TruapiSessionUiState {
  connected: boolean;
  publicKey?: string;
  identityAccountId?: string;
  liteUsername?: string;
  fullUsername?: string;
  primaryUsername?: string;
}

/** Convert the core's decoded session fields into the rendering-friendly
 * shape (hex-encoded keys) the topbar and UI-state cache use. */
export function toSessionUiState(info: SessionUiInfo): TruapiSessionUiState {
  const primaryUsername = info.fullUsername ?? info.liteUsername;
  return {
    connected: true,
    publicKey: info.publicKey,
    ...(info.identityAccountId !== undefined
      ? { identityAccountId: info.identityAccountId }
      : {}),
    ...(info.liteUsername !== undefined
      ? { liteUsername: info.liteUsername }
      : {}),
    ...(info.fullUsername !== undefined
      ? { fullUsername: info.fullUsername }
      : {}),
    ...(primaryUsername !== undefined ? { primaryUsername } : {}),
  };
}

/** Persist (or clear, when disconnected) the boot-rehydration UI-state
 * cache next to the opaque session blob. Best-effort. */
export async function writeUiStateCache(
  detail: TruapiSessionUiState,
): Promise<void> {
  try {
    if (detail.connected) {
      await writeSharedAuthStorage(
        SITE_ID,
        UI_STATE_CACHE_KEY,
        JSON.stringify(detail),
      );
    } else {
      await clearSharedAuthStorage(SITE_ID, UI_STATE_CACHE_KEY);
    }
  } catch (err) {
    log.warn("[dot.li] session UI cache write failed:", err);
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** Validate a parsed UI-state cache blob field by field. The cache is
 * host-written same-origin data, but it can be stale from a different code
 * version or partially corrupted, so a malformed blob degrades to null
 * (bare connected state) rather than being cast into the typed shape. */
function parseUiStateCache(parsed: unknown): TruapiSessionUiState | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const state = parsed as Record<string, unknown>;
  if (
    state.connected !== true ||
    !isOptionalString(state.publicKey) ||
    !isOptionalString(state.identityAccountId) ||
    !isOptionalString(state.liteUsername) ||
    !isOptionalString(state.fullUsername) ||
    !isOptionalString(state.primaryUsername)
  ) {
    return null;
  }
  return {
    connected: true,
    ...(state.publicKey !== undefined ? { publicKey: state.publicKey } : {}),
    ...(state.identityAccountId !== undefined
      ? { identityAccountId: state.identityAccountId }
      : {}),
    ...(state.liteUsername !== undefined
      ? { liteUsername: state.liteUsername }
      : {}),
    ...(state.fullUsername !== undefined
      ? { fullUsername: state.fullUsername }
      : {}),
    ...(state.primaryUsername !== undefined
      ? { primaryUsername: state.primaryUsername }
      : {}),
  };
}

async function readUiStateCache(): Promise<TruapiSessionUiState | null> {
  try {
    const raw = await readSharedAuthStorage(SITE_ID, UI_STATE_CACHE_KEY);
    if (raw === null) {
      return null;
    }
    return parseUiStateCache(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Re-emit the cached UI state for the persisted same-origin session, if any.
 * Used at boot so a reload shows the logged-in badge before any core
 * instance runs. Only emits when a persisted session blob actually exists;
 * without a cached state it degrades to a bare `connected: true`.
 */
export function emitPersistedSessionUiState(): void {
  void (async () => {
    let raw: string | null;
    try {
      raw = await readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    } catch {
      return;
    }
    if (raw === null || raw === "") {
      return;
    }
    dispatchAuthState({
      tag: "Connected",
      session: (await readUiStateCache()) ?? { connected: true },
    });
  })();
}

export function createSessionStoreAdapters(): CoreStorage {
  return {
    async readCoreStorage(key) {
      return readCoreStorageValue(key);
    },
    async writeCoreStorage(key, value) {
      await writeCoreStorageValue(key, value);
    },
    async clearCoreStorage(key) {
      await clearCoreStorageValue(key);
    },
  };
}

async function readCoreStorageValue(
  key: CoreStorageKey,
): Promise<Uint8Array | undefined> {
  if (key.tag === "AuthSession") {
    let raw: string | null;
    try {
      raw = await readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    } catch (err) {
      log.warn("[dot.li] shared auth session read failed:", err);
      return undefined;
    }
    if (raw === null || raw === "") {
      return undefined;
    }
    return decodeStoredBytes(raw, "shared auth session");
  }
  const raw = localStorage.getItem(coreLocalStorageKey(key));
  return raw === null ? undefined : await decodeCoreStorageValue(key, raw);
}

function decodeStoredBytes(
  raw: string,
  description: string,
): Uint8Array | undefined {
  try {
    return hexToBytes(raw);
  } catch (err) {
    log.warn(`[dot.li] ignoring corrupt ${description}:`, err);
    return undefined;
  }
}

async function writeCoreStorageValue(
  key: CoreStorageKey,
  value: Uint8Array,
): Promise<void> {
  if (key.tag === "AuthSession") {
    await writeSharedAuthStorage(
      SITE_ID,
      SHARED_CORE_SESSION_KEY,
      bytesToHex(value),
    );
    emitLocalChange();
    return;
  }
  localStorage.setItem(
    coreLocalStorageKey(key),
    await encodeCoreStorageValue(key, value),
  );
}

async function clearCoreStorageValue(key: CoreStorageKey): Promise<void> {
  if (key.tag === "AuthSession") {
    await clearSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    await writeUiStateCache({ connected: false });
    emitLocalChange();
    return;
  }
  localStorage.removeItem(coreLocalStorageKey(key));
}

function coreLocalStorageKey(key: CoreStorageKey): string {
  switch (key.tag) {
    case "PairingDeviceIdentity":
      return `${CORE_LOCAL_STORAGE_PREFIX}pairing-device-identity`;
    case "PermissionAuthorization":
      return `${CORE_LOCAL_STORAGE_PREFIX}permission:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
    case "AllowanceKeys":
      return `${CORE_LOCAL_STORAGE_PREFIX}allowance-keys:${key.value.sessionId}`;
    case "AutoSigningKey":
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
    // Wallet-bound capabilities for the active pairing: one slot, unlike the
    // legacy per-product `AutoSigningKey` above.
    case "AutoSigningKeys":
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing-keys`;
    // Keyed by root public key so several rings can coexist. The snapshot is
    // public, so it is not treated as secret material below.
    case "RingVrfRegistry":
      return `${CORE_LOCAL_STORAGE_PREFIX}ring-vrf-registry:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
    case "StatementRenewalTargets":
      return `${CORE_LOCAL_STORAGE_PREFIX}statement-renewal-targets`;
    case "LastProcessedPairingStatement":
      return `${CORE_LOCAL_STORAGE_PREFIX}last-processed-pairing-statement`;
    case "AuthSession":
      return `${CORE_LOCAL_STORAGE_PREFIX}auth-session`;
    // Peers address this device by the public counterpart, so the slot name
    // must not move with the session.
    case "DeviceEncryptionKey":
      return `${CORE_LOCAL_STORAGE_PREFIX}device-encryption-key`;
    // Keyed by session and product together: pairing again re-asks the
    // Account Holder, so one session's answer must not be read back for
    // another.
    case "ProductSubtree":
      return `${CORE_LOCAL_STORAGE_PREFIX}product-subtree:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
    // The ledger bounds replays for one wallet and peer pair, so the whole
    // triple has to discriminate the slot.
    case "SsoResponderRequestLedger":
      return `${CORE_LOCAL_STORAGE_PREFIX}sso-responder-ledger:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
  }
}

function storesSecretMaterial(key: CoreStorageKey): boolean {
  return (
    key.tag === "AllowanceKeys" ||
    key.tag === "AutoSigningKey" ||
    key.tag === "AutoSigningKeys" ||
    key.tag === "DeviceEncryptionKey"
  );
}

async function encodeCoreStorageValue(
  key: CoreStorageKey,
  value: Uint8Array,
): Promise<string> {
  if (storesSecretMaterial(key)) {
    const nonce = crypto.getRandomValues(
      new Uint8Array(CORE_SECRET_NONCE_LENGTH),
    );
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        await coreSecretStorageKey(),
        new Uint8Array(value),
      ),
    );
    const stored = new Uint8Array(nonce.length + ciphertext.length);
    stored.set(nonce);
    stored.set(ciphertext, nonce.length);
    return ENCRYPTED_VALUE_PREFIX + bytesToHex(stored);
  }
  return bytesToHex(value);
}

async function decodeCoreStorageValue(
  key: CoreStorageKey,
  raw: string,
): Promise<Uint8Array | undefined> {
  if (!storesSecretMaterial(key)) {
    return decodeStoredBytes(raw, `core storage ${key.tag}`);
  }
  if (!raw.startsWith(ENCRYPTED_VALUE_PREFIX)) {
    // Slots written before at-rest encryption shipped hold the plain key
    // bytes. Re-persist encrypted so the plaintext copy doesn't outlive
    // this read.
    const bytes = decodeStoredBytes(raw, `core storage ${key.tag}`);
    if (bytes === undefined) {
      return undefined;
    }
    log.warn(`[dot.li] re-encrypting legacy plaintext core storage ${key.tag}`);
    localStorage.setItem(
      coreLocalStorageKey(key),
      await encodeCoreStorageValue(key, bytes),
    );
    return bytes;
  }
  const bytes = decodeStoredBytes(
    raw.slice(ENCRYPTED_VALUE_PREFIX.length),
    `core storage ${key.tag}`,
  );
  if (bytes === undefined) {
    return undefined;
  }
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, CORE_SECRET_NONCE_LENGTH) },
        await coreSecretStorageKey(),
        bytes.slice(CORE_SECRET_NONCE_LENGTH),
      ),
    );
  } catch (err) {
    // The slot was written under a key we no longer hold (IndexedDB
    // cleared while localStorage survived, or a session-ephemeral fallback
    // key) or the bytes are corrupt. Drop it: returning the raw bytes
    // would hand ciphertext to the core as key material.
    log.warn(`[dot.li] dropping undecryptable core storage ${key.tag}:`, err);
    localStorage.removeItem(coreLocalStorageKey(key));
    return undefined;
  }
}

// Marks a slot as holding the encrypted format. Legacy plaintext slots are
// bare hex, so the prefix cleanly separates "must decrypt" from "migrate":
// a decrypt failure never falls back to treating ciphertext as plaintext.
const ENCRYPTED_VALUE_PREFIX = "enc1:";

// Standard AES-GCM nonce length. A fresh random nonce is drawn per write and
// stored as the ciphertext prefix: GCM security collapses if a (key, nonce)
// pair is ever reused.
const CORE_SECRET_NONCE_LENGTH = 12;

const KEY_DB_NAME = "dotli-core";
const KEY_DB_STORE = "keys";
const CORE_SECRET_KEY_ID = "allowance-keys";

let coreSecretKeyPromise: Promise<CryptoKey> | undefined;

/**
 * The at-rest key for core signing-secret slots: a random per-install AES key
 * generated non-extractable and persisted in IndexedDB, so the key material
 * itself can never be read out of the browser's crypto implementation — a
 * key derived from bundle data would be computable by anyone. If IndexedDB
 * is unavailable the key degrades to session-ephemeral: values written then
 * fail to decrypt after a reload and are dropped like any corrupt slot.
 */
function coreSecretStorageKey(): Promise<CryptoKey> {
  coreSecretKeyPromise ??= loadOrCreateCoreSecretKey().catch((err: unknown) => {
    log.warn(
      "[dot.li] falling back to a session-ephemeral core-secret storage key:",
      err,
    );
    return generateCoreSecretKey();
  });
  return coreSecretKeyPromise;
}

function generateCoreSecretKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function loadOrCreateCoreSecretKey(): Promise<CryptoKey> {
  const db = await openKeyDb();
  try {
    const existing = await idbGetKey(db);
    if (existing !== undefined) {
      return existing;
    }
    const key = await generateCoreSecretKey();
    try {
      await idbAddKey(db, key);
      return key;
    } catch (err) {
      // add() rejects when the slot is already taken: another tab won the
      // race, so adopt its key instead of splitting the install across two.
      const winner = await idbGetKey(db);
      if (winner !== undefined) {
        return winner;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(KEY_DB_STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("indexedDB open failed"));
    };
  });
}

function idbGetKey(db: IDBDatabase): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(KEY_DB_STORE)
      .objectStore(KEY_DB_STORE)
      .get(CORE_SECRET_KEY_ID);
    request.onsuccess = () => {
      const value: unknown = request.result;
      resolve(isCryptoKey(value) ? value : undefined);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("indexedDB get failed"));
    };
  });
}

function idbAddKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_DB_STORE, "readwrite");
    tx.objectStore(KEY_DB_STORE).add(key, CORE_SECRET_KEY_ID);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("indexedDB add failed"));
    };
    // A commit-time abort (e.g. QuotaExceededError) fires only `abort`;
    // without this the promise never settles and, being memoized, would
    // hang every allowance read/write for the session.
    tx.onabort = () => {
      reject(tx.error ?? new Error("indexedDB add aborted"));
    };
  });
}

/** `instanceof CryptoKey` is unreliable across realms (and the global is
 * missing under happy-dom), so validate the stored record structurally. */
function isCryptoKey(value: unknown): value is CryptoKey {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as CryptoKey).type === "secret"
  );
}

function hexNoPrefix(bytes: Uint8Array): string {
  return bytesToHex(bytes).slice(2);
}

export function onStoredSessionChanged(listener: () => void): () => void {
  const onLocalChange = (): void => {
    listener();
  };
  window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
  const unsubscribeShared = subscribeSharedAuthStorage((change) => {
    if (change.siteId === SITE_ID && change.key === SHARED_CORE_SESSION_KEY) {
      listener();
    }
  });
  return () => {
    window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
    unsubscribeShared();
  };
}
