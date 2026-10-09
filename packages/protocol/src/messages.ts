// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainKey, ChainPeer, ChainSyncKind } from '@dotli/resolver';
import { TIMEOUTS } from '@dotli/config';
import type { SharedWalletOperation, SharedWalletState } from './wallet-storage.js';
import type { CoreCustodyOperation } from './core-custody.js';
import type { WalletOwnerOperation } from './wallet-owner.js';

export interface ProtocolRequestMap {
  warmup: Record<string, never>;
  resolveDotName: { label: string };
  resolveOwner: { label: string };
  resolveSeitySlot: { lookupKey: string };
  resolveExecutableManifest: {
    label: string;
    kind: 'app' | 'widget' | 'worker';
  };
  resolveRootManifest: { label: string };
  authStorageRead: { siteId: string; key: string };
  authStorageWrite: {
    siteId: string;
    key: string;
    value: string;
    walletRevision?: string | null;
  };
  authStorageClear: { siteId: string; key: string };
  modeStorageRead: { siteId: string; key: string };
  modeStorageWrite: { siteId: string; key: string; value: string };
  modeStorageClear: { siteId: string; key: string };
  walletStorage: { siteId: string; operation: SharedWalletOperation };
  coreCustody: { siteId: string; operation: CoreCustodyOperation };
  walletOwner: { siteId: string; operation: WalletOwnerOperation };
  chainConnect: { genesisHash: string; connectionId: string };
  chainSend: { connectionId: string; message: string };
  chainDisconnect: { connectionId: string };
}

export type ProtocolRequestMethod = keyof ProtocolRequestMap;

export interface ProtocolRequestEnvelope<M extends ProtocolRequestMethod = ProtocolRequestMethod> {
  namespace: 'dotli:protocol';
  kind: 'request';
  id: string;
  method: M;
  payload: ProtocolRequestMap[M];
  /**
   * Absolute wall-clock deadline, shared with handlers so their specific error arrives before the caller's generic
   * timeout.
   */
  deadlineMs?: number;
}

/**
 * Turns an untrusted deadline into the resolver's remaining sync budget, less a grace for the typed
 * error to cross postMessage. The only place the deadline is validated.
 */
export function getRequestSyncTimeoutMs(request: ProtocolRequestEnvelope): number | undefined {
  if (typeof request.deadlineMs !== 'number' || !Number.isFinite(request.deadlineMs)) {
    return undefined;
  }
  return Math.max(1, Math.floor(request.deadlineMs - Date.now() - TIMEOUTS.RESPONSE_DELIVERY_GRACE));
}

export interface ProtocolProgressEnvelope {
  namespace: 'dotli:protocol';
  kind: 'progress';
  id: string;
  message: string;
}

export interface ProtocolResponseEnvelope {
  namespace: 'dotli:protocol';
  kind: 'response';
  id: string;
  ok: true;
  result: unknown;
}

export interface ProtocolErrorEnvelope {
  namespace: 'dotli:protocol';
  kind: 'response';
  id: string;
  ok: false;
  /** From `serializeError`. */
  error: string;
  /** Class name of what the sender threw, so the receiver branches on it instead of matching `error` text. */
  errorName?: string;
  /** The sender's stack, for the report: the receiver rebuilds the error and has none of its own. */
  errorStack?: string;
}

export interface ProtocolChainMessageEnvelope {
  namespace: 'dotli:protocol';
  kind: 'chain-message';
  connectionId: string;
  message: string;
}

export interface ProtocolChainHaltEnvelope {
  namespace: 'dotli:protocol';
  kind: 'chain-halt';
  connectionId: string;
}

export interface ProtocolReadyEnvelope {
  namespace: 'dotli:protocol';
  kind: 'ready';
}

/**
 * Whether a chain started from existing smoldot state, sent once per chain. "hit" is a loaded database
 * or an already synced SharedWorker chain, "unavailable" a store that could not answer. The store lives
 * in the protocol origin's IndexedDB, so this is the host's only view of it.
 */
export type SmoldotDbChain = 'relay' | 'hub' | 'bulletin';
export type SmoldotDbOutcome = 'hit' | 'miss' | 'unavailable';

export interface ProtocolSmoldotDbEnvelope {
  namespace: 'dotli:protocol';
  kind: 'smoldot-db';
  chain: SmoldotDbChain;
  outcome: SmoldotDbOutcome;
}

/** Smoldot panicked and every chain is dead, so the client rejects all pending requests at once. */
export interface ProtocolFatalEnvelope {
  namespace: 'dotli:protocol';
  kind: 'fatal';
  message: string;
}

/** The iframe failed to initialize. Its own kind since no request id applies, handled like `fatal`. */
export interface ProtocolInitFailedEnvelope {
  namespace: 'dotli:protocol';
  kind: 'init-failed';
  message: string;
}

/** What a chain reports about its own sync, for the host loading screen. Stops once the chain is ready. */
export interface ProtocolChainSyncEnvelope {
  namespace: 'dotli:protocol';
  kind: 'chain-sync';
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

/** Per-chain facts for telemetry, kept apart from `chain-sync` so UI subscribers need not filter them. */
export interface ProtocolChainDetailEnvelope {
  namespace: 'dotli:protocol';
  kind: 'chain-detail';
  chain: ChainKey;
  dbCache?: 'hit' | 'miss';
  peers?: ChainPeer[];
}

/** Bytes the light client has received so far. Cumulative, so a dropped message costs nothing. */
export interface ProtocolNetBytesEnvelope {
  namespace: 'dotli:protocol';
  kind: 'net-bytes';
  received: number;
}

/** A sibling tab changed a shared-auth key. Drives cross-tab `StorageAdapter.subscribe` callbacks. */
export interface ProtocolAuthStorageChangedEnvelope {
  namespace: 'dotli:protocol';
  kind: 'auth-storage-changed';
  siteId: string;
  key: string;
  value: string | null;
}

export interface ProtocolWalletStorageChangedEnvelope {
  namespace: 'dotli:protocol';
  kind: 'wallet-storage-changed';
  siteId: string;
  state: SharedWalletState;
}

/** Another tab asked for the test wallet; stop it, then release the lease. */
export interface ProtocolWalletOwnerRevokedEnvelope {
  namespace: 'dotli:protocol';
  kind: 'wallet-owner-revoked';
  siteId: string;
  lease: string;
}

export type ProtocolEnvelope =
  | ProtocolRequestEnvelope
  | ProtocolProgressEnvelope
  | ProtocolResponseEnvelope
  | ProtocolErrorEnvelope
  | ProtocolChainMessageEnvelope
  | ProtocolChainHaltEnvelope
  | ProtocolReadyEnvelope
  | ProtocolSmoldotDbEnvelope
  | ProtocolFatalEnvelope
  | ProtocolInitFailedEnvelope
  | ProtocolChainSyncEnvelope
  | ProtocolChainDetailEnvelope
  | ProtocolNetBytesEnvelope
  | ProtocolAuthStorageChangedEnvelope
  | ProtocolWalletStorageChangedEnvelope
  | ProtocolWalletOwnerRevokedEnvelope;

const VALID_KINDS = new Set([
  'request',
  'response',
  'progress',
  'chain-message',
  'chain-halt',
  'ready',
  'smoldot-db',
  'fatal',
  'init-failed',
  'chain-sync',
  'chain-detail',
  'net-bytes',
  'auth-storage-changed',
  'wallet-storage-changed',
  'wallet-owner-revoked',
]);

// postMessage data is untrusted, so chain and kind are checked at runtime. The lists are copied because
// importing them would pull smoldot into every protocol bundle. As `Record<T, true>`, a value missing
// here fails typecheck instead of being dropped silently.
export const ENVELOPE_CHAIN_KEYS = Object.keys({
  relay: true,
  'asset-hub': true,
  bulletin: true,
  people: true,
} satisfies Record<ChainKey, true>) as ChainKey[];

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

// Wider than the union on purpose, since the sender's declared type is a claim and a narrowed check would compile away.
const CACHE_RESULT_VALUES = new Set<string>(['hit', 'miss']);
const SYNC_KIND_VALUES = new Set<string>(ENVELOPE_SYNC_KINDS);

/** Whether a `chain-sync` envelope is safe for the loading UI, where a bad height would render as NaN. */
export function isChainSyncPayloadValid(msg: ProtocolChainSyncEnvelope): boolean {
  if (!CHAIN_KEY_VALUES.has(msg.chain) || !SYNC_KIND_VALUES.has(msg.syncKind)) {
    return false;
  }
  if (
    msg.syncKind === 'peers' &&
    (!Number.isInteger(msg.peers) || (msg.peers ?? -1) < 0 || (msg.peers ?? 0) > 10_000)
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

// Peer ids and roles land in telemetry attributes, so a spoofed frame could write unbounded junk into spans.
const MAX_PEER_ID_LENGTH = 128;
const MAX_PEERS = 50;

/** Whether a `chain-detail` envelope carries values worth recording. */
export function isChainDetailPayloadValid(msg: ProtocolChainDetailEnvelope): boolean {
  if (!CHAIN_KEY_VALUES.has(msg.chain)) {
    return false;
  }
  if (msg.dbCache !== undefined && !CACHE_RESULT_VALUES.has(msg.dbCache)) {
    return false;
  }
  if (msg.peers === undefined) {
    return true;
  }
  if (!Array.isArray(msg.peers) || msg.peers.length > MAX_PEERS) {
    return false;
  }
  return msg.peers.every(
    peer =>
      typeof peer.peerId === 'string' &&
      peer.peerId.length > 0 &&
      peer.peerId.length <= MAX_PEER_ID_LENGTH &&
      typeof peer.roles === 'string' &&
      peer.roles.length <= MAX_PEER_ID_LENGTH &&
      Number.isFinite(peer.bestNumber) &&
      peer.bestNumber >= 0,
  );
}

export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope {
  if (typeof value !== 'object' || value === null || !('namespace' in value) || !('kind' in value)) {
    return false;
  }
  const obj = value as { namespace?: unknown; kind?: unknown };
  return obj.namespace === 'dotli:protocol' && VALID_KINDS.has(obj.kind as string);
}
