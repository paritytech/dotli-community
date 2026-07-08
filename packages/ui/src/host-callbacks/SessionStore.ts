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
import {
  hasStoredSharedAuthSession,
  SHARED_CORE_SESSION_KEY,
} from "@dotli/protocol/auth-storage";
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

async function readUiStateCache(): Promise<TruapiSessionUiState | null> {
  try {
    const raw = await readSharedAuthStorage(SITE_ID, UI_STATE_CACHE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as TruapiSessionUiState).connected
    ) {
      return parsed as TruapiSessionUiState;
    }
    return null;
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
    if (raw === null || !hasStoredSharedAuthSession(raw)) {
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
    return hexToBytes(raw);
  }
  const raw = localStorage.getItem(coreLocalStorageKey(key));
  return raw === null ? undefined : decodeCoreStorageValue(key, raw);
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
    return bytesToHex(allowanceStorageCipher().encrypt(value));
  }
  return bytesToHex(value);
}

function decodeCoreStorageValue(key: CoreStorageKey, raw: string): Uint8Array {
  const bytes = hexToBytes(raw);
  if (key.tag === "AllowanceKeys") {
    return allowanceStorageCipher().decrypt(bytes);
  }
  return bytes;
}

function allowanceStorageCipher(): ReturnType<typeof gcm> {
  return gcm(
    blake2b(textEncoder.encode(SITE_ID), { dkLen: 16 }),
    blake2b(textEncoder.encode("nonce"), { dkLen: 32 }),
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
