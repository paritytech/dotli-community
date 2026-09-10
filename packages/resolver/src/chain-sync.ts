// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What each chain reports about its own sync, for the loading screen.
//
// The light client is embedded in `@parity/truapi-provider` and speaks only
// JSON-RPC over `Connection.send` / `Connection.nextResponse`. That pipe is
// the whole side channel: this module writes requests under reserved string
// ids and claims their replies out of the response stream in `./provider`
// before polkadot-api sees them, so our traffic never reaches papi and papi's
// numeric ids can never collide with ours.
//
// Two sources feed the events. `lifecycle_unstable_follow` reports sync
// milestones where the light client implements it, and `system_health` is
// polled during bootstrap for a live peer count. The follow is optional by
// design: a light client that answers it with a method-not-found error leaves
// peer counts working on their own.

import { log } from "@dotli/shared/log";
import { chainRoleForGenesis, type ChainRole } from "@dotli/config/network";

/** The chains the resolver runs, named by role rather than by chain spec. */
export const CHAIN_KEYS = [
  "relay",
  "custom-relay",
  "asset-hub",
  "bulletin",
  "people",
] as const;
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
 * Smoldot emits two more milestones (modeDecision and stopped) that the
 * loading UI has nothing to say about. `peers` is our own addition, sampled
 * while the chain bootstraps rather than reported by smoldot.
 *
 * `warpSyncProgress` is the only true percentage in here, and it only
 * arrives when a relay has a real warp distance to cover. Short-lived test
 * networks jump straight to `warpSyncFinished`.
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
    // Repeating an unchanged count would wake every listener once a second
    // for nothing.
    const prev = syncHistory.get(`${event.chain}:peers`);
    if (prev !== undefined && prev.peers === event.peers) {
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

/** Which chains report sync, and which of those are sampled for peers. */
export interface SyncReportingConfig {
  milestones: readonly ChainKey[];
  peerCounts: readonly ChainKey[];
}

// Sync reporting is opt-in per process and per chain, because it costs a
// subscription plus an interceptor on every response the chain yields. The
// protocol iframe's direct mode enables it for the chains its loading
// screen actually shows. The SharedWorker never does, so its long-lived
// provider does no work for a UI that cannot observe it.
const milestoneChains = new Set<ChainKey>();
const peerCountChains = new Set<ChainKey>();

export function enableSyncReporting(config: SyncReportingConfig): void {
  for (const chain of config.milestones) {
    milestoneChains.add(chain);
  }
  for (const chain of config.peerCounts) {
    peerCountChains.add(chain);
    // A peer count is useless without the milestone that ends it.
    milestoneChains.add(chain);
  }
}

// Reserved id prefixes for our internal JSON-RPC requests. Chosen so they
// cannot collide with the numeric ids polkadot-api uses, and so the tap can
// recognize and consume the responses before they reach polkadot-api.
const FOLLOW_ID_PREFIX = "__dotli_lifecycle_follow__:";
const HEALTH_ID_PREFIX = "__dotli_health__:";

// Bootstrap is the impatient phase: the loading screen is on screen and a
// second-old peer count is already stale. Once the chain is up the count only
// feeds the network panel, which nobody watches tick by tick, so the poll
// drops to a rate that keeps the number honest without holding the chain busy.
const HEALTH_POLL_INTERVAL_MS = 1_000;
const HEALTH_POLL_SETTLED_INTERVAL_MS = 15_000;
const HEALTH_POLL_TIMEOUT_MS = 2_000;
// How many fast polls a chain gets before the poller drops to the slow rate.
// Only reached when the light client has no `lifecycle_unstable_follow`, since
// a working follow pushes peer counts and stands the poller down.
const HEALTH_POLL_BURST = 120;

/** The fields of a JSON-RPC frame the tap itself looks at. */
export interface ParsedRpcMessage {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

export interface ChainSyncTap {
  /**
   * Claim one response for the side channel. `true` means the frame was ours
   * and must not be forwarded to polkadot-api.
   */
  intercept(parsed: ParsedRpcMessage): boolean;
  stop(): void;
}

// A timer that keeps a Node test process alive is a hang, and the poller is
// best-effort either way.
function unrefHandle(handle: ReturnType<typeof setTimeout>): void {
  (handle as unknown as { unref?: () => void }).unref?.();
}

let healthResponseSeen = false;

/**
 * Warn once per session if our reserved-id requests go unanswered.
 *
 * The whole side channel depends on the light client replying to them. If a
 * provider bump breaks that, milestones and peer counts both go silently
 * dead.
 */
const armSideChannelWatchdog = (() => {
  let armed = false;
  return (): void => {
    if (armed) {
      return;
    }
    armed = true;
    const watchdog = setTimeout(() => {
      if (!healthResponseSeen) {
        log.warn(
          "[dot.li chain-sync] sync side-channel not observed within 5s, loading detail will not update",
        );
      }
    }, 5_000);
    unrefHandle(watchdog);
  };
})();

/**
 * Attach the sync side channel to one chain's JSON-RPC pipe.
 *
 * `send` writes a raw JSON-RPC string onto that chain's connection. The
 * returned tap must see every response, in order, before polkadot-api does.
 * Returns `null` for a chain nobody asked to report, so an unobserved chain
 * costs neither a subscription nor a per-response check.
 */
export function attachChainSync(
  chain: ChainKey,
  send: (message: string) => void,
): ChainSyncTap | null {
  if (!milestoneChains.has(chain)) {
    return null;
  }

  let stopped = false;
  // Subscription id of this chain's `lifecycle_unstable_follow`, learned from
  // the follow reply. Notifications carry no request id, so this is how the
  // tap tells our subscription's events apart from any other traffic.
  let followSubscription: string | null = null;

  let polls = 0;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;
  // Last snapshot, so the next one can be diffed into transitions.
  let lastPhase: string | null = null;
  let lastHealth: string | null = null;
  let lastPeers: number | null = null;
  // Object-held so control-flow analysis does not narrow it to `false` inside
  // the response handler: only the follow callback ever sets it, and TS cannot
  // see that ordering across closures.
  const follow = { works: false };

  const stopHealth = (): void => {
    if (healthTimer !== null) {
      clearTimeout(healthTimer);
      healthTimer = null;
    }
  };

  const scheduleHealth = (delayMs: number): void => {
    stopHealth();
    healthTimer = setTimeout(sendHealth, delayMs);
    unrefHandle(healthTimer);
  };

  // Polling is sequential by design. The next poll goes out one interval
  // after the previous response arrives, so a busy chain is never flooded,
  // and a 2s timeout resends when a response never surfaces. Stops on chain
  // teardown, a dead chain, or the bootstrap cap before the chain settles.
  function sendHealth(): void {
    if (stopped) {
      stopHealth();
      return;
    }
    polls += 1;
    try {
      send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `${HEALTH_ID_PREFIX}${chain}:${String(polls)}`,
          method: "system_health",
          params: [],
        }),
      );
    } catch {
      // The connection was closed under us. Polling is best-effort and
      // simply ends.
      stopped = true;
      stopHealth();
      return;
    }
    scheduleHealth(HEALTH_POLL_TIMEOUT_MS);
  }

  /** Fast while the chain is bootstrapping, slow once the burst is spent. */
  function healthInterval(): number {
    return polls >= HEALTH_POLL_BURST
      ? HEALTH_POLL_SETTLED_INTERVAL_MS
      : HEALTH_POLL_INTERVAL_MS;
  }

  /**
   * Apply one `lifecycle_unstable_follow` state snapshot.
   *
   * The subscription reports the chain's whole state on every change rather
   * than a milestone, so the transitions the loading screen cares about are
   * derived by diffing against the last snapshot. `numPeers` rides along on
   * every event, which is why a chain with a working follow needs no
   * `system_health` polling at all.
   */
  const applyLifecycleState = (result: unknown): void => {
    const state = result as
      | {
          phase?: { kind?: string; target?: number; at?: number };
          numPeers?: number;
          health?: { kind?: string };
        }
      | undefined;
    if (state === undefined) {
      return;
    }
    follow.works = true;
    // The follow supersedes the poller: its peer counts are pushed rather
    // than sampled, so they are both fresher and cheaper.
    stopHealth();

    const peers = state.numPeers;
    if (typeof peers === "number" && Number.isInteger(peers) && peers >= 0) {
      if (peers > 0 && (lastPeers === null || lastPeers === 0)) {
        emitChainSync({ chain, kind: "firstPeer" });
      }
      if (peers !== lastPeers) {
        emitChainSync({
          chain,
          kind: "peers",
          peers,
          isSyncing: state.phase?.kind !== "ready",
        });
      }
      lastPeers = peers;
    }

    const phase = state.phase?.kind;
    if (phase !== undefined && phase !== lastPhase) {
      if (phase === "connecting") {
        emitChainSync({ chain, kind: "connecting" });
      } else if (phase === "ready") {
        emitChainSync({ chain, kind: "bootstrapComplete" });
      }
      lastPhase = phase;
    }
    // Warp progress repeats while the target moves, so it is emitted on every
    // syncing snapshot rather than only on a phase change.
    if (phase === "syncing") {
      const target = state.phase?.target;
      const at = state.phase?.at;
      emitChainSync({
        chain,
        kind: "warpSyncProgress",
        ...(typeof at === "number" ? { at } : {}),
        ...(typeof target === "number" ? { target } : {}),
      });
    }

    const health = state.health?.kind;
    if (health !== undefined && health !== lastHealth) {
      if (health === "ok") {
        // Only a chain that was previously unwell can recover, so the first
        // `ok` of a session is not an event.
        if (lastHealth !== null) {
          emitChainSync({ chain, kind: "recovered", reason: lastHealth });
        }
      } else {
        emitChainSync({ chain, kind: "stalled", reason: health });
      }
      lastHealth = health;
    }
  };

  const handleHealthResponse = (result: unknown): void => {
    healthResponseSeen = true;
    if (follow.works) {
      // The follow started reporting while this poll was in flight. Let it
      // own the peer count from here.
      stopHealth();
      return;
    }
    if (!stopped && healthTimer !== null) {
      scheduleHealth(healthInterval());
    }
    const health = result as { peers?: unknown; isSyncing?: unknown } | null;
    if (
      health === null ||
      typeof health !== "object" ||
      typeof health.peers !== "number" ||
      !Number.isInteger(health.peers) ||
      health.peers < 0 ||
      typeof health.isSyncing !== "boolean"
    ) {
      return;
    }
    emitChainSync({
      chain,
      kind: "peers",
      peers: health.peers,
      isSyncing: health.isSyncing,
    });
  };

  const intercept = (parsed: ParsedRpcMessage): boolean => {
    if (typeof parsed.id === "string") {
      if (parsed.id.startsWith(FOLLOW_ID_PREFIX)) {
        // Reply to our follow request: remember the subscription id so
        // notifications (which carry no request id) can be matched below.
        if (typeof parsed.result === "string") {
          followSubscription = parsed.result;
        } else if (parsed.error !== undefined) {
          // This light client does not implement the lifecycle follow. Peer
          // counts carry the loading detail on their own, so say it once at
          // debug and stop expecting milestones.
          log.debug(
            `[dot.li chain-sync] ${chain} has no lifecycle follow, peer counts only`,
          );
        }
        return true;
      }
      if (parsed.id.startsWith(HEALTH_ID_PREFIX)) {
        handleHealthResponse(parsed.result);
        return true;
      }
      return false;
    }
    if (parsed.method === "lifecycle_unstable_followEvent") {
      const params = parsed.params as
        | { subscription?: unknown; result?: unknown }
        | undefined;
      // The follow reply always precedes its notifications, so an unknown
      // subscription id means the event belongs to someone else: forward it.
      if (
        params === undefined ||
        followSubscription === null ||
        params.subscription !== followSubscription
      ) {
        return false;
      }
      applyLifecycleState(params.result);
      return true;
    }
    return false;
  };

  const stop = (): void => {
    stopped = true;
    stopHealth();
  };

  try {
    send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: `${FOLLOW_ID_PREFIX}${chain}`,
        method: "lifecycle_unstable_follow",
        params: [],
      }),
    );
  } catch (err: unknown) {
    log.warn(
      `[dot.li chain-sync] lifecycle follow send failed for ${chain}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (peerCountChains.has(chain)) {
    armSideChannelWatchdog();
    // Poll immediately: on a warm start the chain bootstraps in well under a
    // second and a delayed first poll would never produce a sample.
    scheduleHealth(0);
  }

  return { intercept, stop };
}
