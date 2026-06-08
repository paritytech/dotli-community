import { SITE_ID } from "@dotli/config/config";
import {
  clearSharedAuthStorage,
  readSharedAuthStorage,
  subscribeSharedAuthStorage,
  writeSharedAuthStorage,
} from "@dotli/protocol/client";
import { bytesToHex, hexToBytes } from "@parity/truapi/scale";
import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import { createResultStream } from "./result-stream";

const LOCAL_CHANGE_EVENT = "dotli:truapi-session-store-changed";

function emitLocalChange(): void {
  window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
}

function emitSessionUiState(connected: boolean): void {
  window.dispatchEvent(
    new CustomEvent("dotli:truapi-session-state", { detail: { connected } }),
  );
}

export function createSessionStoreAdapters(): Pick<
  HostCallbacks,
  "readSession" | "writeSession" | "clearSession" | "subscribeSessionStore"
> {
  return {
    async readSession() {
      const raw = await readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
      if (raw === null || raw === "") {
        emitSessionUiState(false);
        return undefined;
      }
      emitSessionUiState(true);
      return hexToBytes(raw);
    },
    async writeSession(value) {
      await writeSharedAuthStorage(
        SITE_ID,
        SHARED_CORE_SESSION_KEY,
        bytesToHex(value),
      );
      emitLocalChange();
      emitSessionUiState(true);
    },
    async clearSession() {
      await clearSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
      emitLocalChange();
      emitSessionUiState(false);
    },
    subscribeSessionStore() {
      return createResultStream<void>([undefined], (push) => {
        const onLocalChange = (): void => push(undefined);
        window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
        const unsubscribeRemote = subscribeSharedAuthStorage((change) => {
          if (
            change.siteId === SITE_ID &&
            change.key === SHARED_CORE_SESSION_KEY
          ) {
            push(undefined);
          }
        });
        return () => {
          window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
          unsubscribeRemote();
        };
      });
    },
  };
}
