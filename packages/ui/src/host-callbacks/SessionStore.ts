import { SITE_ID } from "@dotli/config/config";
import { gcm } from "@noble/ciphers/aes.js";
import { blake2b } from "@noble/hashes/blake2.js";
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
const textEncoder = new TextEncoder();

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
    publicKey: bytesToHex(info.publicKey),
    ...(info.identityAccountId !== undefined
      ? { identityAccountId: bytesToHex(info.identityAccountId) }
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
  return raw === null ? undefined : decodeCoreStorageValue(key, raw);
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
    encodeCoreStorageValue(key, value),
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
    case "LastProcessedPairingStatement":
      return `${CORE_LOCAL_STORAGE_PREFIX}last-processed-pairing-statement`;
    case "AuthSession":
      return `${CORE_LOCAL_STORAGE_PREFIX}auth-session`;
  }
}

function encodeCoreStorageValue(
  key: CoreStorageKey,
  value: Uint8Array,
): string {
  if (key.tag === "AllowanceKeys") {
    const nonce = crypto.getRandomValues(
      new Uint8Array(ALLOWANCE_NONCE_LENGTH),
    );
    const ciphertext = allowanceStorageCipher(nonce).encrypt(value);
    const stored = new Uint8Array(nonce.length + ciphertext.length);
    stored.set(nonce);
    stored.set(ciphertext, nonce.length);
    return bytesToHex(stored);
  }
  return bytesToHex(value);
}

function decodeCoreStorageValue(
  key: CoreStorageKey,
  raw: string,
): Uint8Array | undefined {
  const bytes = decodeStoredBytes(raw, `core storage ${key.tag}`);
  if (bytes === undefined || key.tag !== "AllowanceKeys") {
    return bytes;
  }
  try {
    const nonce = bytes.subarray(0, ALLOWANCE_NONCE_LENGTH);
    const ciphertext = bytes.subarray(ALLOWANCE_NONCE_LENGTH);
    return allowanceStorageCipher(nonce).decrypt(ciphertext);
  } catch {
    // Slots written before at-rest encryption shipped hold the plain key
    // bytes, so a failed decrypt means the legacy format. Re-persist
    // encrypted so the plaintext copy doesn't outlive this read.
    log.warn(`[dot.li] re-encrypting legacy plaintext core storage ${key.tag}`);
    localStorage.setItem(
      coreLocalStorageKey(key),
      encodeCoreStorageValue(key, bytes),
    );
    return bytes;
  }
}

// Standard AES-GCM nonce length. A fresh random nonce is drawn per write and
// stored as the ciphertext prefix: GCM security collapses if a (key, nonce)
// pair is ever reused.
const ALLOWANCE_NONCE_LENGTH = 12;

function allowanceStorageCipher(nonce: Uint8Array): ReturnType<typeof gcm> {
  return gcm(blake2b(textEncoder.encode(SITE_ID), { dkLen: 16 }), nonce);
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
