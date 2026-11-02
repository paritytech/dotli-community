// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Diffs truapi-provider's per-chain lifecycle snapshots into the milestones the loading screen reacts to.
// The peer list the watch lacks goes over the chain's JSON-RPC under a reserved string id.

import type { ChainLifecycle } from '@parity/truapi-provider';
import { m, reportListener } from '@dotli/metrics';
import { createListenerSet, getErrorMessage, isRecord, log } from '@dotli/shared';
import { getChainRoleForGenesis, type ChainRole } from '@dotli/config/fixed';
import { SYSTEM_PEERS } from './jsonRpcMethods.js';

/** `warpSyncProgress` is the only true percentage, and a chain that never warped emits no warp kinds. */
export type ChainSyncKind =
  | 'firstPeer'
  | 'bootstrapComplete'
  | 'stalled'
  | 'recovered'
  | 'peers'
  | 'connecting'
  | 'warpSyncProgress'
  | 'warpSyncFinished';

export type ChainSyncEvent = {
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
};

/** `peerId` ships as-is, since it is a public node identity and never identifies the visitor. */
export type ChainPeer = {
  peerId: string;
  roles: string;
  bestNumber: number;
};

/** Telemetry-only facts, kept out of `ChainSyncEvent` so UI subscribers need not filter them. */
export type ChainDetail = {
  chain: ChainRole;
  dbCache?: 'hit' | 'miss' | undefined;
  /** Peers held when the chain reported ready. */
  peers?: ChainPeer[] | undefined;
};

export type ParsedRpcMessage = {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
};

export type ChainLifecycleWatch = {
  /** The next lifecycle snapshot, or `undefined` once the watch is closed or the chain is gone. */
  next(): Promise<ChainLifecycle | undefined>;
  /** Ends the watch, so a waiting `next` resolves `undefined`. */
  close(): void;
};

export type ChainSyncTap = {
  /** `true` means the frame was ours and must not reach polkadot-api. */
  intercept(parsed: ParsedRpcMessage): boolean;
  /** Closes the chain's lifecycle watch. A repeated call does nothing. */
  stop(): void;
};

/** The sync milestones and chain facts of one light client, with the replay a late subscriber needs. */
export type ChainSyncReporter = ReturnType<typeof createChainSyncReporter>;

type DetailCallback = (detail: ChainDetail) => void;
type SyncCallback = (event: ChainSyncEvent) => void;

type Params = {
  /** Ask a ready chain for its peer list. Off on a build without metrics, which has nowhere to send it. */
  askPeers: boolean;
};

type AttachChainSyncParams = {
  /** The chain the tap reports on. */
  chain: ChainRole;
  /** Sends one JSON-RPC request on the chain, as JSON text. */
  send: (message: string) => void;
  /** Opens the chain's lifecycle watch. May throw when the chain refuses one. */
  watchLifecycle: () => ChainLifecycleWatch;
};

// A string, so it cannot collide with polkadot-api's numeric ids.
const PEERS_ID_PREFIX = '__dotli_peers__:';

const MAX_PEERS_RECORDED = 25;

/** Builds a reporter with no chain opted in, so it watches no chain until `enableSyncReporting` opts one in. */
export function createChainSyncReporter({ askPeers }: Params) {
  // A throwing listener is a defect in its subscriber, so it is reported, and the other listeners still hear the event.
  const detailListeners = createListenerSet<ChainDetail>({
    onListenerError: reportListener('resolve', 'chain_sync.detail'),
  });
  // Latest per chain and kind, so a reconnecting chain replaces its entry instead of growing the replay.
  const detailHistory = new Map<string, ChainDetail>();

  function onChainDetail(callback: DetailCallback): () => void {
    const unsubscribe = detailListeners.subscribe(callback);
    for (const detail of detailHistory.values()) {
      detailListeners.deliver(callback, detail);
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
    const chain = getChainRoleForGenesis(genesisHash);
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

  function onChainSync(callback: SyncCallback): () => void {
    const unsubscribe = syncListeners.subscribe(callback);
    for (const event of syncHistory.values()) {
      syncListeners.deliver(callback, event);
    }
    return unsubscribe;
  }

  function emitChainSync(event: ChainSyncEvent): void {
    if (!prepareSyncHistory(event)) {
      return;
    }
    syncHistory.set(`${event.chain}:${event.kind}`, event);
    syncListeners.emit(event);
  }

  /** Drops the replay entry `event` outdates. Returns `false` for an event that repeats the last one. */
  function prepareSyncHistory(event: ChainSyncEvent): boolean {
    switch (event.kind) {
      case 'peers': {
        // Unchanged reports would wake every listener once a second.
        const previous = syncHistory.get(`${event.chain}:peers`);
        return previous === undefined || previous.peers !== event.peers || previous.isSyncing !== event.isSyncing;
      }
      case 'stalled':
        // One condition, so a late subscriber must not replay the outdated half.
        syncHistory.delete(`${event.chain}:recovered`);
        return true;
      case 'recovered':
        syncHistory.delete(`${event.chain}:stalled`);
        return true;
      case 'firstPeer':
      case 'bootstrapComplete':
      case 'connecting':
      case 'warpSyncProgress':
      case 'warpSyncFinished':
        return true;
    }
  }

  // Opt-in per chain, since each costs a lifecycle watch.
  const reportingChains = new Set<ChainRole>();

  function enableSyncReporting(chains: readonly ChainRole[]): void {
    for (const chain of chains) {
      reportingChains.add(chain);
    }
  }

  function attachChainSync({ chain, send, watchLifecycle }: AttachChainSyncParams): ChainSyncTap | null {
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
    // `ready` is not terminal, since a chain that warps again returns to it.
    let peersRequested = false;

    function applyLifecycleState(state: ChainLifecycle): void {
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
        applyPhaseChange(phase);
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

      const healthKey = getHealthKey(health);
      if (healthKey !== lastHealth) {
        applyHealthChange(health);
        lastHealth = healthKey;
      }
    }

    function applyPhaseChange(phase: ChainLifecycle['phase']): void {
      switch (phase.kind) {
        case 'connecting':
          emitChainSync({ chain, kind: 'connecting' });
          return;
        case 'syncing':
          // A syncing chain reports its progress on every snapshot, not on the change.
          return;
        case 'ready':
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
          return;
      }
    }

    function applyHealthChange(health: ChainLifecycle['health']): void {
      switch (health.kind) {
        case 'ok':
          if (lastStallReason !== null) {
            emitChainSync({
              chain,
              kind: 'recovered',
              reason: lastStallReason,
            });
          }
          lastStallReason = null;
          return;
        case 'stalled':
          emitChainSync({ chain, kind: 'stalled', reason: health.reason });
          lastStallReason = health.reason;
          return;
      }
    }

    // The peer list is asked once at ready, when it explains the bootstrap time, and only by a reporter that asks peers.
    // `system_peers` is legacy JSON-RPC, so smoldot warns once per chain, but the new API has no peer list.
    function requestPeers(): void {
      if (peersRequested || stopped || !askPeers) {
        return;
      }
      peersRequested = true;
      try {
        send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: `${PEERS_ID_PREFIX}${chain}`,
            method: SYSTEM_PEERS,
            params: [],
          }),
        );
      } catch (error: unknown) {
        // Telemetry only, and it throws only on a connection already gone, which the visitor never notices.
        log.debug(`[dot.li chain-sync] peer list unavailable for ${chain}: ${getErrorMessage(error)}`);
      }
    }

    function handlePeersResponse(result: unknown): void {
      if (!Array.isArray(result)) {
        return;
      }
      const peers: ChainPeer[] = [];
      for (const entry of result.slice(0, MAX_PEERS_RECORDED)) {
        if (!isRecord(entry) || typeof entry['peerId'] !== 'string') {
          continue;
        }
        const roles = entry['roles'];
        const bestNumber = entry['bestNumber'];
        peers.push({
          peerId: entry['peerId'],
          roles: typeof roles === 'string' ? roles : 'UNKNOWN',
          bestNumber: typeof bestNumber === 'number' && Number.isFinite(bestNumber) ? bestNumber : 0,
        });
      }
      emitChainDetail({ chain, peers });
    }

    function intercept(parsed: ParsedRpcMessage): boolean {
      if (typeof parsed.id === 'string' && parsed.id.startsWith(PEERS_ID_PREFIX)) {
        handlePeersResponse(parsed.result);
        return true;
      }
      return false;
    }

    let watch: ChainLifecycleWatch;
    try {
      watch = watchLifecycle();
    } catch (error: unknown) {
      // The loading screen falls back to its own timings, so this is progress, not a failure.
      log.event('Chain lifecycle watch unavailable', { flow: 'protocol', chain, reason: getErrorMessage(error) });
      return { intercept, stop: () => undefined };
    }

    void readLifecycle(watch);

    async function readLifecycle(lifecycle: ChainLifecycleWatch): Promise<void> {
      try {
        // `undefined` once `stop` closes the watch or the chain is gone.
        for (let state; (state = await lifecycle.next()) !== undefined;) {
          applyLifecycleState(state);
        }
      } catch (error: unknown) {
        // As when the watch is refused, the loading screen falls back to its own timings.
        log.event('Chain lifecycle watch ended', { flow: 'protocol', chain, reason: getErrorMessage(error) });
      }
    }

    function stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      watch.close();
    }

    return { intercept, stop };
  }

  return {
    /**
     * Replays past facts, since the database result is known during `connect`, before most subscribers attach.
     * Returns the unsubscribe.
     */
    onChainDetail,
    /**
     * Replays the latest event per chain and kind, so a listener attaching mid-sync knows where each chain stands.
     * Returns the unsubscribe.
     */
    onChainSync,
    /** The context owning the light client opts its chains in, before their first connection. */
    enableSyncReporting,
    /** Records whether a chain started from its stored database. The first answer per chain wins. */
    reportDbCache,
    /**
     * The tap must see every response, in order, before polkadot-api does.
     * Returns `null` for a chain nobody asked to report, so it costs neither a watch nor a per-response check.
     */
    attachChainSync,
  };
}

// The page's one reporter, built at load so a subscriber that attaches late replays what came before it.
export const pageChainSyncReporter = /* @__PURE__ */ createChainSyncReporter({ askPeers: m.enabled });

/** The sync reporting of this context's light client, for the context that owns it and the shell that listens. */
export const chainSync: Pick<ChainSyncReporter, 'onChainDetail' | 'onChainSync' | 'enableSyncReporting'> = {
  onChainDetail: pageChainSyncReporter.onChainDetail,
  onChainSync: pageChainSyncReporter.onChainSync,
  enableSyncReporting: pageChainSyncReporter.enableSyncReporting,
};

// The reason can change while the chain stays stalled.
function getHealthKey(health: ChainLifecycle['health']): string {
  switch (health.kind) {
    case 'ok':
      return 'ok';
    case 'stalled':
      return `stalled:${health.reason}`;
  }
}
