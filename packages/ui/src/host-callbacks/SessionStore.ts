import { SITE_ID } from "@dotli/config/config";
import { bytesToHex, hexToBytes } from "@parity/truapi/scale";
import type { HostCallbacks, SessionUiInfo } from "@parity/truapi-host-wasm";
import {
  buildSharedAuthStorageKey,
  hasStoredSharedAuthSession,
  SHARED_CORE_SESSION_KEY,
} from "@dotli/protocol/auth-storage";
import { createResultStream } from "./result-stream";

const LOCAL_CHANGE_EVENT = "dotli:truapi-session-store-changed";
const STORAGE_KEY = buildSharedAuthStorageKey(SITE_ID, SHARED_CORE_SESSION_KEY);
// JSON cache of the last connected UI state the core reported via
// `sessionUiChanged`. Lives next to the opaque session blob so boot-time
// rehydration never has to decode the blob itself.
const UI_STATE_CACHE_KEY = `${STORAGE_KEY}:ui-state`;
const CHANNEL_NAME = `dotli:truapi-session-store:${SITE_ID}`;

function emitLocalChange(): void {
  window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(undefined);
    channel.close();
  } catch {
    /* BroadcastChannel unavailable: same-tab event and storage event still cover common cases. */
  }
}

export interface TruapiSessionUiState {
  connected: boolean;
  publicKey?: string;
  identityAccountId?: string;
  liteUsername?: string;
  fullUsername?: string;
  primaryUsername?: string;
}

// True once a connected state carrying identity details has been emitted.
// Bare connection events must not downgrade it (e.g. the bridge's post-login
// dispatch racing the richer sessionUiChanged emission).
let richConnectedStateEmitted = false;

function isRichConnectedState(detail: TruapiSessionUiState): boolean {
  return (
    detail.connected &&
    (detail.publicKey !== undefined ||
      detail.identityAccountId !== undefined ||
      detail.liteUsername !== undefined ||
      detail.fullUsername !== undefined ||
      detail.primaryUsername !== undefined)
  );
}

function emitSessionUiState(detail: TruapiSessionUiState): void {
  richConnectedStateEmitted = isRichConnectedState(detail);
  window.dispatchEvent(
    new CustomEvent("dotli:truapi-session-state", { detail }),
  );
}

/**
 * Emit a bare connected/disconnected UI state. A bare `connected: true` is
 * dropped when a richer connected state (username/account) was already
 * emitted, so it can never downgrade the topbar badge.
 */
export function emitSessionConnectionState(connected: boolean): void {
  if (connected && richConnectedStateEmitted) {
    return;
  }
  emitSessionUiState({ connected });
}

function toSessionUiState(info: SessionUiInfo): TruapiSessionUiState {
  const primaryUsername = info.fullUsername ?? info.liteUsername;
  return {
    connected: info.connected,
    ...(info.publicKey !== undefined
      ? { publicKey: bytesToHex(info.publicKey) }
      : {}),
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

function writeUiStateCache(detail: TruapiSessionUiState): void {
  try {
    if (detail.connected) {
      localStorage.setItem(UI_STATE_CACHE_KEY, JSON.stringify(detail));
    } else {
      localStorage.removeItem(UI_STATE_CACHE_KEY);
    }
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable; the cache only speeds up boot rehydration and the core re-emits once it runs.
  } catch {
    /* cache write is best-effort */
  }
}

function readUiStateCache(): TruapiSessionUiState | null {
  try {
    const raw = localStorage.getItem(UI_STATE_CACHE_KEY);
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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null || !hasStoredSharedAuthSession(raw)) {
      return;
    }
    emitSessionUiState(readUiStateCache() ?? { connected: true });
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable; boot rehydration is best-effort and the core re-emits once it runs.
  } catch {
    /* no readable persisted session */
  }
}

export function createSessionStoreAdapters(): Pick<
  HostCallbacks,
  | "readSession"
  | "writeSession"
  | "clearSession"
  | "subscribeSessionStore"
  | "sessionUiChanged"
> {
  return {
    async readSession() {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(STORAGE_KEY);
      } catch {
        raw = null;
      }
      if (raw === null || raw === "") {
        return undefined;
      }
      return hexToBytes(raw);
    },
    async writeSession(value) {
      localStorage.setItem(STORAGE_KEY, bytesToHex(value));
      emitLocalChange();
    },
    async clearSession() {
      localStorage.removeItem(STORAGE_KEY);
      writeUiStateCache({ connected: false });
      emitLocalChange();
      emitSessionUiState({ connected: false });
    },
    sessionUiChanged(info) {
      const detail = toSessionUiState(info);
      writeUiStateCache(detail);
      emitSessionUiState(detail);
    },
    subscribeSessionStore() {
      return createResultStream<undefined>([undefined], (push) => {
        const onLocalChange = (): void => {
          push(undefined);
        };
        window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
        const onStorage = (event: StorageEvent): void => {
          if (event.key === STORAGE_KEY) {
            push(undefined);
          }
        };
        window.addEventListener("storage", onStorage);
        let channel: BroadcastChannel | null = null;
        try {
          channel = new BroadcastChannel(CHANNEL_NAME);
          channel.addEventListener("message", onLocalChange);
        } catch {
          channel = null;
        }
        return () => {
          window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
          window.removeEventListener("storage", onStorage);
          if (channel !== null) {
            channel.removeEventListener("message", onLocalChange);
            channel.close();
          }
        };
      });
    },
  };
}
