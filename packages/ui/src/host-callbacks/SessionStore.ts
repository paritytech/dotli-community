import { SITE_ID } from "@dotli/config/config";
import { bytesToHex, hexToBytes } from "@parity/truapi/scale";
import type { HostCallbacks, SessionUiInfo } from "@parity/truapi-host-wasm";
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
import { createResultStream } from "./result-stream";
import { dispatchAuthState } from "./AuthState";

const LOCAL_CHANGE_EVENT = "dotli:truapi-session-store-changed";
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
  "readSession" | "writeSession" | "clearSession" | "subscribeSessionStore"
> {
  return {
    async readSession() {
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
    },
    async writeSession(value) {
      await writeSharedAuthStorage(
        SITE_ID,
        SHARED_CORE_SESSION_KEY,
        bytesToHex(value),
      );
      emitLocalChange();
    },
    async clearSession() {
      await clearSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
      await writeUiStateCache({ connected: false });
      emitLocalChange();
    },
    subscribeSessionStore() {
      return createResultStream<undefined>([undefined], (push) => {
        const onLocalChange = (): void => {
          push(undefined);
        };
        window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
        const unsubscribeShared = subscribeSharedAuthStorage((change) => {
          if (
            change.siteId === SITE_ID &&
            change.key === SHARED_CORE_SESSION_KEY
          ) {
            push(undefined);
          }
        });
        return () => {
          window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
          unsubscribeShared();
        };
      });
    },
  };
}
