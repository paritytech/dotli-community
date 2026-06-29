import { SITE_ID } from "@dotli/config/config";
import { RemotePermissionRequest as RemotePermissionRequestCodec } from "@parity/truapi";
import { bytesToHex, hexToBytes } from "@parity/truapi/scale";
import type {
  HostDevicePermissionRequest,
  RemotePermissionRequest,
} from "@parity/truapi";
import type {
  CoreStorageKey,
  HostCallbacks,
  PermissionAuthorizationRequest,
  SessionUiInfo,
} from "@parity/truapi-host-wasm";
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
import { dispatchAuthState } from "./AuthState";

const LOCAL_CHANGE_EVENT = "dotli:truapi-session-store-changed";
const CORE_LOCAL_STORAGE_PREFIX = "dotli:core:";
const PERMISSION_KEY_PREFIX = "truapi:permissions:";
const textEncoder = new TextEncoder();

const DEVICE_PERMISSION_STORAGE_SLUG: Record<
  HostDevicePermissionRequest,
  string
> = {
  Notifications: "notifications",
  Camera: "camera",
  Microphone: "microphone",
  Bluetooth: "bluetooth",
  NFC: "nfc",
  Location: "location",
  Clipboard: "clipboard",
  OpenUrl: "open-url",
  Biometrics: "biometrics",
};

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
  } catch {
    /* cache write is best-effort */
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
      (parsed as TruapiSessionUiState).connected === true
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

export function createSessionStoreAdapters(): Pick<
  HostCallbacks,
  "readCoreStorage" | "writeCoreStorage" | "clearCoreStorage"
> {
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
    let raw: string | null = null;
    try {
      raw = await readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    } catch {
      raw = null;
    }
    if (raw === null || raw === "") {
      return undefined;
    }
    return hexToBytes(raw);
  }
  const raw = localStorage.getItem(coreLocalStorageKey(key));
  return raw === null ? undefined : hexToBytes(raw);
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
  localStorage.setItem(coreLocalStorageKey(key), bytesToHex(value));
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
      return `${CORE_LOCAL_STORAGE_PREFIX}permission:${permissionStorageKey(
        key.value.productId,
        key.value.request,
      )}`;
    case "AuthSession":
      return `${CORE_LOCAL_STORAGE_PREFIX}auth-session`;
  }
}

function permissionStorageKey(
  productId: string,
  request: PermissionAuthorizationRequest,
): string {
  const product = productScope(productId);
  switch (request.tag) {
    case "Device":
      return `${PERMISSION_KEY_PREFIX}product:${product}:device:${DEVICE_PERMISSION_STORAGE_SLUG[request.value]}`;
    case "Remote":
      return `${PERMISSION_KEY_PREFIX}product:${product}:remote:${hexWithoutPrefix(
        RemotePermissionRequestCodec.enc(
          canonicalRemotePermissionRequest(request.value),
        ),
      )}`;
  }
}

function canonicalRemotePermissionRequest(
  request: RemotePermissionRequest,
): RemotePermissionRequest {
  if (request.permission.tag !== "Remote") {
    return request;
  }
  const domains = request.permission.value.domains
    .map((domain) => domain.toLowerCase())
    .sort()
    .filter(
      (domain, index, values) => index === 0 || values[index - 1] !== domain,
    );
  return { permission: { tag: "Remote", value: { domains } } };
}

function productScope(productId: string): string {
  return hexWithoutPrefix(textEncoder.encode(productId));
}

function hexWithoutPrefix(bytes: Uint8Array): string {
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
