// Signing adapters — translate TrUAPI `HostSign*Request/Response` (Uint8Array
// `Hex` fields) into the `0x${string}` shape consumed by `@dotli/auth`'s Sign
// modals. These live here until dotli migrates to a TrUAPI-native signing
// flow (D1).

import type * as T from "@truapi/client";
import type { WasmHostCallbacks } from "@truapi/host-shared";
import type { UserSession } from "@novasamatech/host-papp";
import { getAuthState } from "@dotli/auth/auth";
import {
  showSignPayloadModal,
  showSignRawModal,
  type ContainerSignPayloadRequest,
  type SigningResult as PappSigningResult,
} from "@dotli/auth/signing";
import { log } from "@dotli/shared/log";
import { getPermissionStatus } from "../permissions";
import { showNotification } from "../notification";
import { toHexPrefixed, fromHexPrefixed } from "./hex";

function getSession(): UserSession | null {
  const state = getAuthState();
  return state.status === "authenticated" ? state.session : null;
}

function toContainerSignPayload(
  payload: T.SigningPayload,
): ContainerSignPayloadRequest["payload"] {
  return {
    blockHash: toHexPrefixed(payload.blockHash),
    blockNumber: toHexPrefixed(payload.blockNumber),
    era: toHexPrefixed(payload.era),
    genesisHash: toHexPrefixed(payload.genesisHash),
    method: toHexPrefixed(payload.method),
    nonce: toHexPrefixed(payload.nonce),
    specVersion: toHexPrefixed(payload.specVersion),
    tip: toHexPrefixed(payload.tip),
    transactionVersion: toHexPrefixed(payload.transactionVersion),
    signedExtensions: payload.signedExtensions,
    version: payload.version,
    assetId: payload.assetId ? toHexPrefixed(payload.assetId) : undefined,
    metadataHash: payload.metadataHash
      ? toHexPrefixed(payload.metadataHash)
      : undefined,
    mode: payload.mode,
    withSignedTransaction: payload.withSignedTransaction,
  };
}

function toSigningResult(result: PappSigningResult): T.SigningResult {
  return {
    signature: fromHexPrefixed(result.signature),
    signedTransaction:
      result.signedTransaction !== undefined
        ? fromHexPrefixed(result.signedTransaction)
        : undefined,
  };
}

function createSignPayload(label: string): WasmHostCallbacks["signPayload"] {
  return async (request) => {
    const payload = request.value;
    log.warn(`[${label}] signPayload invoked:`, {
      genesisHash: toHexPrefixed(payload.genesisHash),
    });
    if (getPermissionStatus(label, "ChainSubmit") !== "granted") {
      showNotification({
        label: `${label}.dot`,
        text: 'Transaction blocked — enable "Sign Transactions" in the permissions menu.',
        dismissMs: 6000,
        browserNotification: false,
      });
      throw new Error("Permission denied");
    }
    const session = getSession();
    if (!session) {
      throw new Error("Not connected");
    }
    const result = await showSignPayloadModal(
      session,
      toContainerSignPayload(payload),
      label,
    );
    return { tag: "V2", value: toSigningResult(result) };
  };
}

function createSignRaw(label: string): WasmHostCallbacks["signRaw"] {
  return async (request) => {
    log.warn(`[${label}] signRaw invoked`);
    const session = getSession();
    if (!session) {
      throw new Error("Not connected");
    }
    const result = await showSignRawModal(session, request.value.data, label);
    return { tag: "V2", value: toSigningResult(result) };
  };
}

export function createSigningAdapters(label: string): Pick<
  WasmHostCallbacks,
  "signPayload" | "signRaw"
> {
  return {
    signPayload: createSignPayload(label),
    signRaw: createSignRaw(label),
  };
}
