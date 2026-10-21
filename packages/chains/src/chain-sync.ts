// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Diffs truapi-provider's per-chain lifecycle snapshots into the milestones the loading screen reacts to.
// The peer list the watch lacks goes over the chain's JSON-RPC under a reserved string id.

import type { ChainLifecycle } from '@parity/truapi-provider';
import { m, reportListener } from '@dotli/metrics';
import { createListenerSet, errorMessage, log } from '@dotli/shared';
import { chainRoleForGenesis, type ChainRole } from '@dotli/config/fixed';

/** `warpSyncProgress` is the only true percentage, and a chain that never warped emits no warp kinds. */
export const CHAIN_SYNC_KINDS = [
  'firstPeer',
  'bootstrapComplete',
  'stalled',
  'recovered',
  'peers',
  'connecting',
  'warpSyncProgress',
  'warpSyncFinished',
] as const;
export type ChainSyncKind = (typeof CHAIN_SYNC_KINDS)[number];

export interface ChainSyncEvent {
  chain: ChainRole;
  kind: ChainSyncKind;
  /** On `stalled` and `recovered`. */
  reason?: string | undefined;
  /** On `peers`. */
  peers?: number | undefined;
  /** On `peers`. */
  isSyncing?: boolean | undefined;
  /** Block proven so far, on `warpSyncProgress`. */
  at?: number | undefined;
  /** On `warpSyncProgress`. */
  target?: number | undefined;
  /** On `warpSyncFinished`. */
  finalized?: number | undefined;
}

/** `peerId` ships as-is, since it is a public node identity and never identifies the visitor. */
export interface ChainPeer {
  peerId: string;
  roles: string;
  bestNumber: number;
}

/** Telemetry-only facts, kept out of `ChainSyncEvent` so UI subscribers need not filter them. */
export interface ChainDetail {
  chain: ChainRole;
  dbCache?: 'hit' | 'miss' | undefined;
  /** Peers held when the chain reported ready. */
  peers?: ChainPeer[] | undefined;
}

// A string, so it cannot collide with polkadot-api's numeric ids.
const PEERS_ID_PREFIX = '__dotli_peers__:';

// The peer list is asked once at ready, when it explains the bootstrap time, and only by a reporter that asks peers.
// `system_peers` is legacy JSON-RPC, so smoldot warns once per chain, but the new API has no peer list.
const MAX_PEERS_RECORDED = 25;

export interface ParsedRpcMessage {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

export interface ChainLifecycleWatch {
  next(): Promise<ChainLifecycle | undefined>;
  close(): void;
}

export interface ChainSyncTap {
  /** `true` means the frame was ours and must not reach polkadot-api. */
  intercept(parsed: ParsedRpcMessage): boolean;
  stop(): void;
}

type DetailCallback = (detail: ChainDetail) => void;
type SyncCallback = (event: ChainSyncEvent) => void;

export interface ChainSyncReporterOptions {
  /** Ask a ready chain for its peer list. Off on a build without metrics, which has nowhere to send it. */
  askPeers: boolean;
}

/** The sync milestones and chain facts of one light client, with the replay a late subscriber needs. */
export interface ChainSyncReporter {
  /** Replays past facts, since the database result is known during `connect`, before most subscribers attach. */
  onChainDetail: (cb: DetailCallback) => () => void;
  /** Replays the latest event per chain and kind, so a listener attaching mid-sync knows where each chain stands. */
  onChainSync: (cb: SyncCallback) => () => void;
  /** The context owning the light client opts its chains in. */
  enableSyncReporting: (chains: readonly ChainRole[]) => void;
  reportDbCache: (genesisHash: string, warm: boolean) => void;
  /**
   * The tap must see every response, in order, before polkadot-api does.
   * Returns `null` for a chain nobody asked to report, so it costs neither a watch nor a per-response check.
   */
  attachChainSync: (
    chain: ChainRole,
    send: (message: string) => void,
    watchLifecycle: () => ChainLifecycleWatch,
  ) => ChainSyncTap | null;
}

export function createChainSyncReporter(options: ChainSyncReporterOptions): ChainSyncReporter {
  // A throwing listener is a defect in its subscriber, so it is reported, and the other listeners still hear the event.
  const detailListeners = createListenerSet<ChainDetail>({
    onListenerError: reportListener('resolve', 'chain_sync.detail'),
  });
  // Latest per chain and kind, so a reconnecting chain replaces its entry instead of growing the replay.
  const detailHistory = new Map<string, ChainDetail>();

  function onChainDetail(cb: DetailCallback): () => void {
    const unsubscribe = detailListeners.subscribe(cb);
    for (const detail of detailHistory.values()) {
      detailListeners.deliver(cb, detail);
    }
    return unsubscribe;
  }

  function emitChainDetail(detail: ChainDetail): void {
    const kind = detail.dbCache === undefined ? 'peers' : 'dbCache';
    detailHistory.set(`${detail.chain}:${kind}`, detail);
    detailListeners.emit(detail);
  }

  function reportDbCache(genesisHash: string, warm: boolean): void {
    // A custom relay reports as `relay`, since the provider's one catalog cannot tell them apart.
    const chain = chainRoleForGenesis(genesisHash);
    if (chain === null) {
      return;
    }
    // First answer wins. Bulletin connects twice, and the second load always misses.
    if (detailHistory.has(`${chain}:dbCache`)) {
      return;
    }
    emitChainDetail({ chain, dbCache: warm ? 'hit' : 'miss' });
  }

  const syncListeners = createListenerSet<ChainSyncEvent>({
    onListenerError: reportListener('resolve', 'chain_sync.sync'),
  });
  // Latest event per chain and kind, so the replay stays bounded.
  const syncHistory = new Map<string, ChainSyncEvent>();

  function onChainSync(cb: SyncCallback): () => void {
    const unsubscribe = syncListeners.subscribe(cb);
    for (const event of syncHistory.values()) {
      syncListeners.deliver(cb, event);
    }
    return unsubscribe;
  }

  function emitChainSync(event: ChainSyncEvent): void {
    if (event.kind === 'peers') {
      // Unchanged reports would wake every listener once a second.
      const prev = syncHistory.get(`${event.chain}:peers`);
      if (prev !== undefined && prev.peers === event.peers && prev.isSyncing === event.isSyncing) {
        return;
      }
    } else if (event.kind === 'stalled') {
      // One condition, so a late subscriber must not replay the outdated half.
      syncHistory.delete(`${event.chain}:recovered`);
    } else if (event.kind === 'recovered') {
      syncHistory.delete(`${event.chain}:stalled`);
    }
    syncHistory.set(`${event.chain}:${event.kind}`, event);
    syncListeners.emit(event);
  }

  // Opt-in per chain, since each costs a lifecycle watch.
  const reportingChains = new Set<ChainRole>();

  function enableSyncReporting(chains: readonly ChainRole[]): void {
    for (const chain of chains) {
      reportingChains.add(chain);
    }
  }

  function attachChainSync(
    chain: ChainRole,
    send: (message: string) => void,
    watchLifecycle: () => ChainLifecycleWatch,
  ): ChainSyncTap | null {
    if (!reportingChains.has(chain)) {
      return null;
    }

    let stopped = false;
    let lastPhase: string | null = null;
    let lastHealth: string | null = null;
    let lastStallReason: string | null = null;
    let lastPeers: number | null = null;
    let lastWarpAt: number | null = null;
    let firstPeerEmitted = false;

    const applyLifecycleState = (state: ChainLifecycle): void => {
      const { peers, phase, health } = state;
      if (peers > 0 && !firstPeerEmitted) {
        firstPeerEmitted = true;
        emitChainSync({ chain, kind: 'firstPeer' });
      }
      if (peers !== lastPeers) {
        emitChainSync({
          chain,
          kind: 'peers',
          peers,
          isSyncing: phase.kind !== 'ready',
        });
      }
      lastPeers = peers;

      if (phase.kind !== lastPhase) {
        if (phase.kind === 'connecting') {
          emitChainSync({ chain, kind: 'connecting' });
        } else if (phase.kind === 'ready') {
          // Before `bootstrapComplete`, so the warp never finishes after the chain is up.
          if (lastWarpAt !== null) {
            emitChainSync({
              chain,
              kind: 'warpSyncFinished',
              finalized: lastWarpAt,
            });
          }
          emitChainSync({ chain, kind: 'bootstrapComplete' });
          requestPeers();
        }
        lastPhase = phase.kind;
      }
      // On every syncing snapshot, since the target keeps moving.
      if (phase.kind === 'syncing') {
        lastWarpAt = phase.at;
        emitChainSync({
          chain,
          kind: 'warpSyncProgress',
          at: phase.at,
          target: phase.target,
        });
      }

      // The reason can change while the chain stays stalled.
      const healthKey = health.kind === 'stalled' ? `stalled:${health.reason}` : health.kind;
      if (healthKey !== lastHealth) {
        if (health.kind === 'ok') {
          if (lastStallReason !== null) {
            emitChainSync({
              chain,
              kind: 'recovered',
              reason: lastStallReason,
            });
          }
          lastStallReason = null;
        } else {
          emitChainSync({ chain, kind: 'stalled', reason: health.reason });
          lastStallReason = health.reason;
        }
        lastHealth = healthKey;
      }
    };

    // `ready` is not terminal, since a chain that warps again returns to it.
    let peersRequested = false;
    const requestPeers = (): void => {
      if (peersRequested || stopped || !options.askPeers) {
        return;
      }
      peersRequested = true;
      try {
        send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: `${PEERS_ID_PREFIX}${chain}`,
            method: 'system_peers',
            params: [],
          }),
        );
      } catch (err: unknown) {
        // Telemetry only, and it throws only on a connection already gone, which the visitor never notices.
        log.debug(`[dot.li chain-sync] peer list unavailable for ${chain}: ${errorMessage(err)}`);
      }
    };

    const handlePeersResponse = (result: unknown): void => {
      if (!Array.isArray(result)) {
        return;
      }
      const peers: ChainPeer[] = [];
      for (const entry of result.slice(0, MAX_PEERS_RECORDED)) {
        const peer = entry as {
          peerId?: unknown;
          roles?: unknown;
          bestNumber?: unknown;
        };
        if (typeof peer.peerId !== 'string') {
          continue;
        }
        peers.push({
          peerId: peer.peerId,
          roles: typeof peer.roles === 'string' ? peer.roles : 'UNKNOWN',
          bestNumber: typeof peer.bestNumber === 'number' && Number.isFinite(peer.bestNumber) ? peer.bestNumber : 0,
        });
      }
      emitChainDetail({ chain, peers });
    };

    const intercept = (parsed: ParsedRpcMessage): boolean => {
      if (typeof parsed.id === 'string' && parsed.id.startsWith(PEERS_ID_PREFIX)) {
        handlePeersResponse(parsed.result);
        return true;
      }
      return false;
    };

    let watch: ChainLifecycleWatch;
    try {
      watch = watchLifecycle();
    } catch (err: unknown) {
      // The loading screen falls back to its own timings, so this is progress, not a failure.
      log.event('Chain lifecycle watch unavailable', { flow: 'protocol', chain, reason: errorMessage(err) });
      return { intercept, stop: () => undefined };
    }

    void (async () => {
      try {
        // `undefined` once `stop` closes the watch or the chain is gone.
        for (let state; (state = await watch.next()) !== undefined;) {
          applyLifecycleState(state);
        }
      } catch (err: unknown) {
        // As when the watch is refused, the loading screen falls back to its own timings.
        log.event('Chain lifecycle watch ended', { flow: 'protocol', chain, reason: errorMessage(err) });
      }
    })();

    const stop = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      watch.close();
    };

    return { intercept, stop };
  }

  return { onChainDetail, onChainSync, enableSyncReporting, reportDbCache, attachChainSync };
}

// The page's one reporter.
export const { onChainDetail, onChainSync, enableSyncReporting, reportDbCache, attachChainSync } =
  /* @__PURE__ */ createChainSyncReporter({ askPeers: m.enabled });
