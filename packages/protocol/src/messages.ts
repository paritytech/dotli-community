// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainKey, ChainSyncKind } from "@dotli/resolver/smoldot";

export interface ProtocolRequestMap {
  warmup: Record<string, never>;
  resolveDotName: { label: string };
  resolveOwner: { label: string };
  resolveExecutableManifest: {
    label: string;
    kind: "app" | "widget" | "worker";
  };
  resolveRootManifest: { label: string };
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

/**
 * Unsolicited broadcast of what a chain reports about its own sync.
 *
 * Drives the host loading screen: milestones move the bar, peer counts feed
 * the detail line under it. Stops arriving once the chain is ready.
 */
export interface ProtocolChainSyncEnvelope {
  namespace: "dotli:protocol";
  kind: "chain-sync";
  chain: ChainKey;
  syncKind: ChainSyncKind;
  reason?: string;
  peers?: number;
  isSyncing?: boolean;
  /** Warp position and destination, on `warpSyncProgress`. */
  at?: number;
  target?: number;
  /** Block the warp settled on, on `warpSyncFinished`. */
  finalized?: number;
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
  | ProtocolChainSyncEnvelope
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
  "chain-sync",
  "auth-storage-changed",
]);

// postMessage data is untrusted and the envelope type alone cannot reject a
// spoofed field, so the chain and the kind are checked at runtime. The lists
// are repeated rather than imported because importing a value from the
// resolver's smoldot module would drag smoldot into every bundle that talks
// to the protocol.
//
// They are written as `Record<T, true>` rather than an array with
// `satisfies T[]`, because an array only proves every entry is valid and
// says nothing about the ones missing. A kind added to the resolver and
// forgotten here would then be dropped in silence. As a record, a missing
// key fails typecheck, and `chainSyncKinds` in the tests fails too.
/** Every chain the envelope accepts. Exhaustive against `ChainKey`. */
export const ENVELOPE_CHAIN_KEYS = Object.keys({
  relay: true,
  "custom-relay": true,
  "asset-hub": true,
  bulletin: true,
  people: true,
} satisfies Record<ChainKey, true>) as ChainKey[];

/** Every milestone the envelope accepts. Exhaustive against `ChainSyncKind`. */
export const ENVELOPE_SYNC_KINDS = Object.keys({
  firstPeer: true,
  bootstrapComplete: true,
  stalled: true,
  recovered: true,
  peers: true,
  connecting: true,
  warpSyncProgress: true,
  warpSyncFinished: true,
} satisfies Record<ChainSyncKind, true>) as ChainSyncKind[];

const CHAIN_KEY_VALUES = new Set<string>(ENVELOPE_CHAIN_KEYS);
const SYNC_KIND_VALUES = new Set<string>(ENVELOPE_SYNC_KINDS);

/**
 * Whether a `chain-sync` envelope carries values the loading UI can trust.
 *
 * Rejects unknown chains and kinds, a peer count that is not a sane integer,
 * and any block height that is not a finite positive number, since those
 * drive the bar and would render as NaN.
 */
export function isChainSyncPayloadValid(
  msg: ProtocolChainSyncEnvelope,
): boolean {
  if (!CHAIN_KEY_VALUES.has(msg.chain) || !SYNC_KIND_VALUES.has(msg.syncKind)) {
    return false;
  }
  if (
    msg.syncKind === "peers" &&
    (!Number.isInteger(msg.peers) ||
      (msg.peers ?? -1) < 0 ||
      (msg.peers ?? 0) > 10_000)
  ) {
    return false;
  }
  for (const height of [msg.at, msg.target, msg.finalized]) {
    if (height !== undefined && (!Number.isFinite(height) || height < 0)) {
      return false;
    }
  }
  return true;
}

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
