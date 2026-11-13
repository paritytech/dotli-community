// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Diffs truapi-provider's per-chain lifecycle snapshots into the milestones the loading screen reacts to.
// The peer list the watch lacks goes over the chain's JSON-RPC under a reserved string id.

import type { ChainLifecycle } from '@parity/truapi-provider';
import { createReporter, defineCount, m } from '@dotli/metrics';
import { createListenerSet, isRecord } from '@dotli/shared';
import { getChainRoleForGenesis, type ChainRole } from '@dotli/config/fixed';
import { SYSTEM_PEERS } from './jsonRpcMethods.js';

const resolveReport = createReporter({ flow: 'resolve' });
const protocolReport = createReporter({ flow: 'protocol' });

/** Tagged `outcome` (error) and `reason` (`refused` or `ended`). */
const chainLifecycleWatchMetric = defineCount<'error'>('chain_sync.lifecycle_watch');

/** A peer-list request whose connection was already gone. Tagged `outcome` (error) and `reason` (`closed`). */
const chainPeersRequestMetric = defineCount<'error'>('chain_sync.peers_request');

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
  /** Closes the chain's lifecycle watch, and applies no snapshot after it. A repeated call does nothing. */
  stop(): void;
};

/** The sync milestones and chain facts of one light client, with the replay a late subscriber needs. */
export type ChainSyncReporter = ReturnType<typeof createChainSyncReporter>;

type Params = {
  /** Ask a ready chain for its peer list. Off on a build without metrics, which has nowhere to send it. */
  askPeers: boolean;
};

/** What a chain last reported, kept across its taps so a tap that takes over goes on from it. */
type ChainSyncState = {
  phase: ChainLifecycle['phase']['kind'] | null;
  /** `getHealthKey` of the last health. */
  health: string | null;
  stallReason: string | null;
  peers: number | null;
  /** The last block a warp proved in this run, for `warpSyncFinished`. */
  warpAt: number | null;
  /** Whether this run emitted `firstPeer`. */
  firstPeer: boolean;
  /** Whether this run asked the chain for its peers. A flag, since a chain that warps again returns to `ready`. */
  peersRequested: boolean;
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
    onListenerError: resolveReport.listener('chain_sync.detail'),
  });
  // Latest per chain and kind, so a reconnecting chain replaces its entry instead of growing the replay.
  const detailHistory = new Map<string, ChainDetail>();

  function onChainDetail(callback: (detail: ChainDetail) => void): () => void {
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
    onListenerError: resolveReport.listener('chain_sync.sync'),
  });
  // Latest event per chain and kind, so the replay stays bounded.
  const syncHistory = new Map<string, ChainSyncEvent>();

  function onChainSync(callback: (event: ChainSyncEvent) => void): () => void {
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
    const key = `${event.chain}:${event.kind}`;
    // `set` keeps a key's first position, so the replay would run a chain's new step before its outdated ones.
    syncHistory.delete(key);
    syncHistory.set(key, event);
    syncListeners.emit(event);
  }

  function dropSyncHistory(chain: ChainRole, kinds: readonly ChainSyncKind[]): void {
    for (const kind of kinds) {
      syncHistory.delete(`${chain}:${kind}`);
    }
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

  // A chain outlives its taps, so what it reported is kept per chain.
  const chainSyncStates = new Map<ChainRole, ChainSyncState>();

  function getChainSyncState(chain: ChainRole): ChainSyncState {
    const known = chainSyncStates.get(chain);
    if (known !== undefined) {
      return known;
    }
    const created: ChainSyncState = {
      phase: null,
      health: null,
      stallReason: null,
      peers: null,
      warpAt: null,
      firstPeer: false,
      peersRequested: false,
    };
    chainSyncStates.set(chain, created);
    return created;
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

    const sync = getChainSyncState(chain);
    let stopped = false;

    function applyLifecycleState(state: ChainLifecycle): void {
      const { peers, phase, health } = state;
      if (peers > 0 && !sync.firstPeer) {
        sync.firstPeer = true;
        emitChainSync({ chain, kind: 'firstPeer' });
      }
      if (peers !== sync.peers) {
        sync.peers = peers;
        emitChainSync({
          chain,
          kind: 'peers',
          peers,
          isSyncing: phase.kind !== 'ready',
        });
      }

      if (phase.kind !== sync.phase) {
        const previous = sync.phase;
        sync.phase = phase.kind;
        applyPhaseChange(previous, phase);
      }
      // On every syncing snapshot, since the target keeps moving.
      if (phase.kind === 'syncing') {
        sync.warpAt = phase.at;
        emitChainSync({
          chain,
          kind: 'warpSyncProgress',
          at: phase.at,
          target: phase.target,
        });
      }

      const healthKey = getHealthKey(health);
      if (healthKey !== sync.health) {
        sync.health = healthKey;
        applyHealthChange(health);
      }
    }

    function applyPhaseChange(previous: ChainSyncState['phase'], phase: ChainLifecycle['phase']): void {
      switch (phase.kind) {
        case 'connecting':
          // A chain's first tap starts its first run, which has nothing to drop.
          if (previous !== null) {
            startRun();
          }
          emitChainSync({ chain, kind: 'connecting' });
          return;
        case 'syncing':
          // A warp again outdates the last warp's end and the ready chain it led to.
          if (previous === 'ready') {
            dropSyncHistory(chain, ['warpSyncFinished', 'bootstrapComplete']);
          }
          // A syncing chain reports its progress on every snapshot, not on the change.
          return;
        case 'ready':
          // Before `bootstrapComplete`, so the warp never finishes after the chain is up.
          if (sync.warpAt !== null) {
            emitChainSync({
              chain,
              kind: 'warpSyncFinished',
              finalized: sync.warpAt,
            });
          }
          emitChainSync({ chain, kind: 'bootstrapComplete' });
          requestPeers();
          return;
      }
    }

    // A chain that connects again starts over, so a late subscriber must not see the old run's ready chain.
    function startRun(): void {
      sync.firstPeer = false;
      sync.peersRequested = false;
      sync.warpAt = null;
      dropSyncHistory(chain, ['firstPeer', 'warpSyncProgress', 'warpSyncFinished', 'bootstrapComplete']);
    }

    function applyHealthChange(health: ChainLifecycle['health']): void {
      switch (health.kind) {
        case 'ok': {
          const stallReason = sync.stallReason;
          sync.stallReason = null;
          if (stallReason !== null) {
            emitChainSync({
              chain,
              kind: 'recovered',
              reason: stallReason,
            });
          }
          return;
        }
        case 'stalled':
          sync.stallReason = health.reason;
          emitChainSync({ chain, kind: 'stalled', reason: health.reason });
          return;
      }
    }

    // The peer list is asked once at ready, when it explains the bootstrap time, and only by a reporter that asks peers.
    // `system_peers` is legacy JSON-RPC, so smoldot warns once per chain, but the new API has no peer list.
    function requestPeers(): void {
      if (sync.peersRequested || stopped || !askPeers) {
        return;
      }
      sync.peersRequested = true;
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
        protocolReport.expected(error, {
          step: 'chain_peers_request',
          metric: chainPeersRequestMetric,
          reason: 'closed',
        });
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
      // The loading screen falls back to its own timings, so the visitor never notices.
      protocolReport.expected(error, {
        step: 'chain_lifecycle_watch',
        metric: chainLifecycleWatchMetric,
        reason: 'refused',
      });
      return { intercept, stop: () => undefined };
    }

    void readLifecycle(watch);

    async function readLifecycle(lifecycle: ChainLifecycleWatch): Promise<void> {
      try {
        // `undefined` once `stop` closes the watch or the chain is gone.
        for (let state; (state = await lifecycle.next()) !== undefined;) {
          // A snapshot already on its way when `stop` ran is read off the watch but not applied.
          if (stopped) {
            continue;
          }
          applyLifecycleState(state);
        }
      } catch (error: unknown) {
        // As when the watch is refused, the loading screen falls back to its own timings.
        protocolReport.expected(error, {
          step: 'chain_lifecycle_watch',
          metric: chainLifecycleWatchMetric,
          reason: 'ended',
        });
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
     * The replay holds the chain's current run only, in the order each event was last emitted.
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
     * Never throws: a refused lifecycle watch returns a tap that does nothing, and a failed peers send is counted.
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
