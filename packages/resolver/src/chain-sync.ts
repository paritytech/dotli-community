// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What each chain reports about its own sync, for the loading screen.
//
// The light client is embedded in `@parity/truapi-provider`, whose
// `lifecycle(genesis)` watch reports each chain's phase, peer count and health
// on every change. This module diffs those snapshots into the milestones the
// loading screen reacts to.
//
// The one question the watch does not answer, which peers a chain held when it
// came up, still rides the chain's JSON-RPC pipe: the request goes out under a
// reserved string id and `./provider` hands its reply here before
// polkadot-api sees it, so papi's numeric ids can never collide with ours.

import type { ChainLifecycle } from "@parity/truapi-provider";
// Import via the package specifier, not a relative path. `prodNoAnalyticsAliases`
// rewrites `@dotli/metrics/metrics` to the no-op at bundle time.
import { m } from "@dotli/metrics/metrics";
import { log } from "@dotli/shared/log";
import { chainRoleForGenesis, type ChainRole } from "@dotli/config/network";

/** The chains the resolver runs, named by role rather than by chain spec. */
export const CHAIN_KEYS = ["relay", "asset-hub", "bulletin", "people"] as const;
export type ChainKey = (typeof CHAIN_KEYS)[number];

const CHAIN_KEY_BY_ROLE: Record<ChainRole, ChainKey> = {
  relay: "relay",
  assethub: "asset-hub",
  bulletin: "bulletin",
  people: "people",
};

/**
 * Which chain a genesis hash belongs to, or `null` for one this network does
 * not define. A custom relay reports as `relay`: the provider resolves every
 * chain from its genesis through one catalog and cannot tell the two apart,
 * and the loading screen treats them the same way regardless.
 */
export function chainKeyForGenesis(genesisHash: string): ChainKey | null {
  const role = chainRoleForGenesis(genesisHash);
  return role === null ? null : CHAIN_KEY_BY_ROLE[role];
}

/**
 * What a chain reports about its own sync.
 *
 * `peers` is our own addition: the watch reports a peer count with every
 * state, and it goes out whenever the count changes.
 *
 * `warpSyncProgress` is the only true percentage in here, and it only arrives
 * when a relay has a real warp distance to cover. `warpSyncFinished` closes
 * that run. A chain that never warped emits neither.
 */
export const CHAIN_SYNC_KINDS = [
  "firstPeer",
  "bootstrapComplete",
  "stalled",
  "recovered",
  "peers",
  "connecting",
  "warpSyncProgress",
  "warpSyncFinished",
] as const;
export type ChainSyncKind = (typeof CHAIN_SYNC_KINDS)[number];

export interface ChainSyncEvent {
  chain: ChainKey;
  kind: ChainSyncKind;
  /** Why sync stopped progressing, on `stalled` and `recovered`. */
  reason?: string;
  /** Peer count, on `peers`. */
  peers?: number;
  /** Whether the chain is still catching up, on `peers`. */
  isSyncing?: boolean;
  /** Block the warp has proven so far, on `warpSyncProgress`. */
  at?: number;
  /** Block the warp is heading for, on `warpSyncProgress`. */
  target?: number;
  /** Block the warp settled on, on `warpSyncFinished`. */
  finalized?: number;
}

/**
 * One peer of one chain, as `system_peers` reports it.
 *
 * `peerId` is shipped as-is. These are the public libp2p identities of
 * infrastructure nodes, published in chain specs and visible to anyone on the
 * network: they identify a remote server, never the person browsing.
 */
export interface ChainPeer {
  peerId: string;
  roles: string;
  bestNumber: number;
}

/**
 * Facts about a chain that are worth recording once rather than watching.
 *
 * Separate from `ChainSyncEvent` because nothing on the loading screen reacts
 * to these: they exist for telemetry, and a UI subscriber should not have to
 * filter them out of the stream it does react to.
 */
export interface ChainDetail {
  chain: ChainKey;
  /** Whether the light client resumed this chain from its stored database. */
  dbCache?: "hit" | "miss";
  /** Peers held at the moment the chain reported ready. */
  peers?: ChainPeer[];
}

type DetailCallback = (detail: ChainDetail) => void;
const detailListeners = new Set<DetailCallback>();
// Latest fact per chain and kind. Keyed rather than appended so a chain that
// reconnects replaces its entry instead of growing the replay without limit.
const detailHistory = new Map<string, ChainDetail>();

/**
 * Subscribe to per-chain telemetry facts.
 *
 * Replays what has already been reported, because the database result is known
 * during `connect` and a subscriber that attaches after the first chain is up
 * would otherwise never learn it.
 */
export function onChainDetail(cb: DetailCallback): () => void {
  detailListeners.add(cb);
  for (const detail of detailHistory.values()) {
    try {
      cb(detail);
      // eslint-disable-next-line no-restricted-syntax -- defensive replay: one buggy late subscriber must not block registration.
    } catch {
      /* listener threw during replay */
    }
  }
  return () => {
    detailListeners.delete(cb);
  };
}

function emitChainDetail(detail: ChainDetail): void {
  const kind = detail.dbCache === undefined ? "peers" : "dbCache";
  detailHistory.set(`${detail.chain}:${kind}`, detail);
  for (const cb of detailListeners) {
    try {
      cb(detail);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the broadcast.
    } catch {
      /* listener threw */
    }
  }
}

/**
 * Record whether a chain started from its stored database or from the
 * chain-spec checkpoint. Called by `./provider` during connect, which is the
 * only place the answer exists.
 */
export function reportDbCache(genesisHash: string, warm: boolean): void {
  const chain = chainKeyForGenesis(genesisHash);
  if (chain === null) {
    return;
  }
  // First answer wins. Bulletin opens two connections and the store is read
  // at most once per chain, so the second load always misses and would
  // otherwise overwrite a genuine hit.
  if (detailHistory.has(`${chain}:dbCache`)) {
    return;
  }
  emitChainDetail({ chain, dbCache: warm ? "hit" : "miss" });
}

type SyncCallback = (event: ChainSyncEvent) => void;
const syncListeners = new Set<SyncCallback>();
// Latest event per chain and kind, insertion-ordered. Bounded, so late
// subscribers replay at most kinds x chains events.
const syncHistory = new Map<string, ChainSyncEvent>();

/**
 * Subscribe to what the chains report about their sync.
 *
 * Late subscribers first receive the latest event per chain and kind, then
 * continue with live ones, so a listener that attaches mid-sync still knows
 * where each chain stands. Returns an unsubscribe function.
 */
export function onChainSync(cb: SyncCallback): () => void {
  syncListeners.add(cb);
  for (const event of syncHistory.values()) {
    try {
      cb(event);
      // eslint-disable-next-line no-restricted-syntax -- defensive replay: one buggy late subscriber must not block registration.
    } catch {
      /* listener threw during replay */
    }
  }
  return () => {
    syncListeners.delete(cb);
  };
}

function emitChainSync(event: ChainSyncEvent): void {
  if (event.kind === "peers") {
    // Repeating an unchanged report would wake every listener once a second
    // for nothing. `isSyncing` is part of the report, so a flip with a stable
    // count still goes out.
    const prev = syncHistory.get(`${event.chain}:peers`);
    if (
      prev !== undefined &&
      prev.peers === event.peers &&
      prev.isSyncing === event.isSyncing
    ) {
      return;
    }
  } else if (event.kind === "stalled") {
    // `stalled` and `recovered` describe one condition. Keeping both in the
    // replay history would let a late subscriber end on the outdated half.
    syncHistory.delete(`${event.chain}:recovered`);
  } else if (event.kind === "recovered") {
    syncHistory.delete(`${event.chain}:stalled`);
  }
  syncHistory.set(`${event.chain}:${event.kind}`, event);
  for (const cb of syncListeners) {
    try {
      cb(event);
      // eslint-disable-next-line no-restricted-syntax -- defensive multicast: one buggy subscriber must not block the broadcast.
    } catch {
      /* listener threw */
    }
  }
}

// Sync reporting is opt-in per process and per chain, because it costs a
// lifecycle watch on every connection to the chain. The protocol iframe, in
// direct mode, enables it for the chains its loading screen and network panel
// show. The SharedWorker never does, so its long-lived provider does no work
// for a UI that cannot observe it.
const reportingChains = new Set<ChainKey>();

export function enableSyncReporting(chains: readonly ChainKey[]): void {
  for (const chain of chains) {
    reportingChains.add(chain);
  }
}

// Reserved id prefix for our internal JSON-RPC request. Chosen so it cannot
// collide with the numeric ids polkadot-api uses, and so the tap can recognize
// and consume the response before it reaches polkadot-api.
const PEERS_ID_PREFIX = "__dotli_peers__:";

// A peer list is a forensic snapshot, not a readout: it answers "who was this
// chain talking to, and were they themselves caught up" after the fact. Asked
// once, when the chain reports ready, because that is the moment the answer
// explains the time the bootstrap took.
//
// Only asked when metrics are on, since telemetry is its only reader.
// `system_peers` is legacy JSON-RPC, and smoldot warns once per chain on the
// first legacy call. The new API has no peer list to ask instead.
const MAX_PEERS_RECORDED = 25;

/** The fields of a JSON-RPC frame the tap itself looks at. */
export interface ParsedRpcMessage {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

/** The part of truapi-provider's `LifecycleWatch` the tap uses. */
export interface ChainLifecycleWatch {
  next(): Promise<ChainLifecycle | undefined>;
  close(): void;
}

export interface ChainSyncTap {
  /**
   * Claim one response for the side channel. `true` means the frame was ours
   * and must not be forwarded to polkadot-api.
   */
  intercept(parsed: ParsedRpcMessage): boolean;
  stop(): void;
}

/**
 * Report the sync of one chain from its lifecycle watch.
 *
 * `send` writes a raw JSON-RPC string onto the connection of that chain, and
 * the returned tap must see every response, in order, before polkadot-api
 * does. `watchLifecycle` opens the watch, and is only called for a chain
 * somebody asked to report. Returns `null` for any other chain, so an
 * unobserved chain costs neither a watch nor a per-response check.
 */
export function attachChainSync(
  chain: ChainKey,
  send: (message: string) => void,
  watchLifecycle: () => ChainLifecycleWatch,
): ChainSyncTap | null {
  if (!reportingChains.has(chain)) {
    return null;
  }

  let stopped = false;
  // Last snapshot, so the next one can be diffed into transitions.
  let lastPhase: string | null = null;
  let lastHealth: string | null = null;
  let lastStallReason: string | null = null;
  let lastPeers: number | null = null;
  // Highest block the warp proved, so the milestone that ends it can say where
  // it landed. Null for a chain that never warped.
  let lastWarpAt: number | null = null;
  // Latched: a chain that drops to zero peers and finds them again has not
  // found its first peer twice.
  let firstPeerEmitted = false;

  /**
   * Apply one lifecycle snapshot.
   *
   * The watch reports the whole chain state on every change rather than a
   * milestone, so the transitions the loading screen cares about are derived
   * by diffing against the last snapshot.
   */
  const applyLifecycleState = (state: ChainLifecycle): void => {
    const { peers, phase, health } = state;
    if (peers > 0 && !firstPeerEmitted) {
      firstPeerEmitted = true;
      emitChainSync({ chain, kind: "firstPeer" });
    }
    if (peers !== lastPeers) {
      emitChainSync({
        chain,
        kind: "peers",
        peers,
        isSyncing: phase.kind !== "ready",
      });
    }
    lastPeers = peers;

    if (phase.kind !== lastPhase) {
      if (phase.kind === "connecting") {
        emitChainSync({ chain, kind: "connecting" });
      } else if (phase.kind === "ready") {
        // Ordered before `bootstrapComplete` so a listener reading milestones
        // in sequence never sees the warp finish after the chain is already up.
        if (lastWarpAt !== null) {
          emitChainSync({
            chain,
            kind: "warpSyncFinished",
            finalized: lastWarpAt,
          });
        }
        emitChainSync({ chain, kind: "bootstrapComplete" });
        requestPeers();
      }
      lastPhase = phase.kind;
    }
    // Warp progress repeats while the target moves, so it is emitted on every
    // syncing snapshot rather than only on a phase change.
    if (phase.kind === "syncing") {
      lastWarpAt = phase.at;
      emitChainSync({
        chain,
        kind: "warpSyncProgress",
        at: phase.at,
        target: phase.target,
      });
    }

    // The reason is the half of a stall worth showing, and it can change while
    // the chain stays stalled, so the pair is what gets compared.
    const healthKey =
      health.kind === "stalled" ? `stalled:${health.reason}` : health.kind;
    if (healthKey !== lastHealth) {
      if (health.kind === "ok") {
        // Only a chain that was previously unwell can recover, so the first
        // `ok` of a session is not an event.
        if (lastStallReason !== null) {
          emitChainSync({
            chain,
            kind: "recovered",
            reason: lastStallReason,
          });
        }
        lastStallReason = null;
      } else {
        emitChainSync({ chain, kind: "stalled", reason: health.reason });
        lastStallReason = health.reason;
      }
      lastHealth = healthKey;
    }
  };

  // Guarded rather than relying on the ready transition firing once: `ready` is
  // not terminal, so a chain that warps again returns to it later.
  let peersRequested = false;
  const requestPeers = (): void => {
    if (peersRequested || stopped || !m.enabled) {
      return;
    }
    peersRequested = true;
    try {
      send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `${PEERS_ID_PREFIX}${chain}`,
          method: "system_peers",
          params: [],
        }),
      );
    } catch (err: unknown) {
      // The peer list is telemetry, not a step the load depends on, and the
      // only way this throws is a connection that has already gone. Louder
      // handling would report a failure the visitor never experienced.
      log.debug(
        `[dot.li chain-sync] peer list unavailable for ${chain}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      if (typeof peer.peerId !== "string") {
        continue;
      }
      peers.push({
        peerId: peer.peerId,
        roles: typeof peer.roles === "string" ? peer.roles : "UNKNOWN",
        bestNumber:
          typeof peer.bestNumber === "number" &&
          Number.isFinite(peer.bestNumber)
            ? peer.bestNumber
            : 0,
      });
    }
    emitChainDetail({ chain, peers });
  };

  const intercept = (parsed: ParsedRpcMessage): boolean => {
    if (
      typeof parsed.id === "string" &&
      parsed.id.startsWith(PEERS_ID_PREFIX)
    ) {
      handlePeersResponse(parsed.result);
      return true;
    }
    return false;
  };

  let watch: ChainLifecycleWatch;
  try {
    watch = watchLifecycle();
  } catch (err: unknown) {
    // Only a chain nothing is connected to refuses a watch, and the caller
    // opens this one right after connecting. The loading screen falls back to
    // its own timings, so this is worth a warning rather than a failure.
    log.warn(
      `[dot.li chain-sync] lifecycle watch unavailable for ${chain}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { intercept, stop: () => undefined };
  }

  void (async () => {
    try {
      // `undefined` once the watch is closed, which `stop` does, or once the
      // chain is gone.
      for (let state; (state = await watch.next()) !== undefined;) {
        applyLifecycleState(state);
      }
    } catch (err: unknown) {
      log.warn(
        `[dot.li chain-sync] lifecycle watch failed for ${chain}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
