// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export interface ProtocolRequestMap {
  warmup: Record<string, never>;
  resolveDotName: { label: string };
  resolveOwner: { label: string };
  resolveExecutableManifest: {
    label: string;
    kind: "app" | "widget" | "worker";
  };
  resolveRootManifest: { label: string };
  authHasSession: { siteId: string };
  authStorageRead: { siteId: string; key: string };
  authStorageWrite: { siteId: string; key: string; value: string };
  authStorageClear: { siteId: string; key: string };
  modeStorageRead: { siteId: string; key: string };
  modeStorageWrite: { siteId: string; key: string; value: string };
  modeStorageClear: { siteId: string; key: string };
  chainConnect: { genesisHash: string; connectionId: string };
  chainSend: { connectionId: string; message: string };
  chainDisconnect: { connectionId: string };
}

export type ProtocolRequestMethod = keyof ProtocolRequestMap;

export interface ProtocolRequestEnvelope<
  M extends ProtocolRequestMethod = ProtocolRequestMethod,
> {
  namespace: "dotli:protocol";
  kind: "request";
  id: string;
  method: M;
  payload: ProtocolRequestMap[M];
}

export interface ProtocolProgressEnvelope {
  namespace: "dotli:protocol";
  kind: "progress";
  id: string;
  message: string;
}

export interface ProtocolResponseEnvelope {
  namespace: "dotli:protocol";
  kind: "response";
  id: string;
  ok: true;
  result: unknown;
}

export interface ProtocolErrorEnvelope {
  namespace: "dotli:protocol";
  kind: "response";
  id: string;
  ok: false;
  error: string;
}

export interface ProtocolChainMessageEnvelope {
  namespace: "dotli:protocol";
  kind: "chain-message";
  connectionId: string;
  message: string;
}

export interface ProtocolChainHaltEnvelope {
  namespace: "dotli:protocol";
  kind: "chain-halt";
  connectionId: string;
}

export interface ProtocolReadyEnvelope {
  namespace: "dotli:protocol";
  kind: "ready";
}

/**
 * Unsolicited broadcast from the protocol iframe (or its SharedWorker) when
 * smoldot has crashed/panicked. A panic leaves every chain dead. Any
 * in-flight request would hang indefinitely, so the client rejects all
 * pending requests on receipt instead of waiting for a per-request timeout.
 */
export interface ProtocolFatalEnvelope {
  namespace: "dotli:protocol";
  kind: "fatal";
  message: string;
}

/**
 * Signals that the iframe failed to initialize before emitting any response.
 *
 * A dedicated kind avoids a sentinel id collision. No request was in flight
 * and no id is expected, so clients route it to the same path as
 * `kind: "fatal"`: reject everything pending, then block new work.
 */
export interface ProtocolInitFailedEnvelope {
  namespace: "dotli:protocol";
  kind: "init-failed";
  message: string;
}

// Unsolicited notification from the host iframe to its parent window when a
// sibling tab writes or clears a shared-auth storage key. Drives cross-tab
// `StorageAdapter.subscribe` callbacks. See `@dotli/protocol/client`
// `subscribeSharedAuthStorage` and `apps/protocol/src/main.ts`'s
// BroadcastChannel relay.
export interface ProtocolAuthStorageChangedEnvelope {
  namespace: "dotli:protocol";
  kind: "auth-storage-changed";
  siteId: string;
  key: string;
  value: string | null;
}

export type ProtocolEnvelope =
  | ProtocolRequestEnvelope
  | ProtocolProgressEnvelope
  | ProtocolResponseEnvelope
  | ProtocolErrorEnvelope
  | ProtocolChainMessageEnvelope
  | ProtocolChainHaltEnvelope
  | ProtocolReadyEnvelope
  | ProtocolFatalEnvelope
  | ProtocolInitFailedEnvelope
  | ProtocolAuthStorageChangedEnvelope;

const VALID_KINDS = new Set([
  "request",
  "response",
  "progress",
  "chain-message",
  "chain-halt",
  "ready",
  "fatal",
  "init-failed",
  "auth-storage-changed",
]);

export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope {
  if (
    typeof value !== "object" ||
    value === null ||
    !("namespace" in value) ||
    !("kind" in value)
  ) {
    return false;
  }
  const obj = value as { namespace?: unknown; kind?: unknown };
  return (
    obj.namespace === "dotli:protocol" && VALID_KINDS.has(obj.kind as string)
  );
}
