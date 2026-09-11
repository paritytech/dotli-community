// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Live per-chain block arrivals for the network panel.
//
// The panel used to poll every 6 seconds, standing up and tearing down a client
// per chain per tick. A 6 second poll cannot say whether a 2 second block
// arrived on time, so this holds one subscription per chain instead and stamps
// each new best block as it lands. That is both finer grained and cheaper: the
// metadata each client fetches is paid once for the session rather than every
// tick.
//
// Arrival time is deliberately what gets measured, not the block's own
// timestamp. Under a light client a parachain head is learned through relay
// inclusion, so arrivals are burstier than authoring, but arrival is what this
// session actually has and so it is what an honest indicator should show.

import {
  getActiveChainRoles,
  type ActiveChainRole,
  type ChainRole,
} from "@dotli/config/network";
import { log } from "@dotli/shared/log";

/** How a single block's arrival compares to what the chain promises. */
export type BlockHealth = "onTime" | "late" | "veryLate";

export interface BlockBar {
  readonly number: number;
  readonly health: BlockHealth;
  /** How long after the previous block this one arrived. */
  readonly gapMs: number;
}

export interface ChainStatus {
  readonly role: ChainRole;
  readonly label: string;
  /** Bars oldest first, so a renderer can append without reversing. */
  readonly bars: readonly BlockBar[];
  readonly latest: number | null;
  /** Milliseconds since the last block landed, or null before the first. */
  readonly sinceLast: number | null;
  readonly blockTimeMs: number;
  /** False when the active network offers no endpoint for this chain. */
  readonly reachable: boolean;
  /**
   * What the light client says this chain is doing, or null before it has
   * said anything. Distinct from `bars`, which only shows up once blocks
   * start arriving: a chain can be `ready` with no block yet observed.
   */
  readonly phase: ChainPhase | null;
  /**
   * Peers the light client currently holds for this chain, or null where the
   * backend never reports one (a trusted provider, or a chain the shell did
   * not opt into sampling).
   */
  readonly peers: number | null;
}

/**
 * Bars kept per chain.
 *
 * Deliberately larger than any strip can show. The panel measures how many
 * marks its own width fits and renders that many, so this is only a ceiling on
 * memory: it must never be the thing that decides what a visitor sees, or the
 * history silently ends at a number nobody chose.
 */
const MAX_BARS = 120;

/**
 * How long follows outlive a closed panel.
 *
 * Long enough that closing and reopening feels continuous, short enough that a
 * panel nobody looks at is not holding chain connections. That matters most in
 * shared-worker mode, where the cap of 10 is shared across every open tab.
 */
const IDLE_GRACE_MS = 60_000;

/** Late past 1.5x the promised time, very late past 3x. */
export function classifyGap(gapMs: number, blockTimeMs: number): BlockHealth {
  if (gapMs <= blockTimeMs * 1.5) {
    return "onTime";
  }
  return gapMs <= blockTimeMs * 3 ? "late" : "veryLate";
}

interface ChainState {
  role: ActiveChainRole;
  bars: BlockBar[];
  latest: number | null;
  lastAt: number | null;
  unsubscribe: (() => void) | null;
}

/**
 * What the light client is moving right now, for the panel's footer.
 *
 * `total` is what the DAG root declares for the product archive, so it is
 * known only once the content phase starts, and null on a load served from
 * cache that never fetched anything.
 */
/**
 * Where a chain is in its own bootstrap, as the light client reports it.
 *
 * Mirrors `LifecyclePhase` from `lifecycle_unstable_follow`, plus `stalled`,
 * which the watchdog reports alongside the phase rather than instead of it.
 */
export type ChainPhase = "connecting" | "syncing" | "ready" | "stalled";

export interface TransferState {
  /** Bytes per second across every chain socket, over a short window. */
  readonly bytesPerSecond: number | null;
  /** Bytes of the product archive fetched so far. */
  readonly fetched: number | null;
  /** Size the archive declares, or null when it declared none. */
  readonly total: number | null;
}

/** Everything needed to watch one chain, injected so tests can drive it. */
export interface BlockSource {
  /**
   * Subscribe to a chain's best block. Calls back with a block number each
   * time the head changes. Returns an unsubscribe.
   */
  subscribe: (
    genesis: string,
    onBlock: (blockNumber: number) => void,
  ) => () => void;
  /** Whether the active backend can reach this chain at all. */
  isReachable: (genesis: string) => boolean;
}

let source: BlockSource | null = null;
let chains = new Map<ChainRole, ChainState>();
// Held apart from `chains` because peer samples arrive on the protocol's sync
// stream whether or not the panel is open, and outlive a watch that was torn
// down after the idle grace.
let peerCounts = new Map<ChainRole, number>();
let phases = new Map<ChainRole, ChainPhase>();
let transfer: TransferState = {
  bytesPerSecond: null,
  fetched: null,
  total: null,
};
let listeners = new Set<() => void>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let watching = false;

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
      // eslint-disable-next-line no-restricted-syntax -- one bad renderer must not stop the others.
    } catch {
      /* listener threw */
    }
  }
}

function recordBlock(state: ChainState, blockNumber: number): void {
  // `bestBlocks$` re-emits whenever the best-block chain changes shape, not
  // only when the head advances: a new descendant, a finalization or a reorg
  // all republish a list whose first entry is the block already recorded.
  // Without this guard the same block was pushed over and over, so the history
  // filled with copies of a handful of blocks while the strip, which keys marks
  // by block number, could only ever draw one of each. That is why the bars
  // stalled around 18 and dropped whenever an old copy fell off the end.
  if (state.latest !== null && blockNumber <= state.latest) {
    return;
  }
  const now = Date.now();
  // The first block of a session has no gap to judge, so it is not coloured
  // against a guess. It still anchors the next one.
  if (state.lastAt !== null) {
    const gapMs = now - state.lastAt;
    state.bars.push({
      number: blockNumber,
      health: classifyGap(gapMs, state.role.blockTimeMs),
      gapMs,
    });
    if (state.bars.length > MAX_BARS) {
      state.bars.shift();
    }
  }
  state.latest = blockNumber;
  state.lastAt = now;
  notify();
}

function attach(state: ChainState): void {
  if (state.unsubscribe !== null || source === null) {
    return;
  }
  if (!source.isReachable(state.role.genesis)) {
    return;
  }
  try {
    state.unsubscribe = source.subscribe(state.role.genesis, (blockNumber) => {
      recordBlock(state, blockNumber);
    });
  } catch (err: unknown) {
    log.warn(
      `[dot.li network] could not watch ${state.role.role}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function detachAll(): void {
  for (const state of chains.values()) {
    state.unsubscribe?.();
    state.unsubscribe = null;
  }
}

/**
 * Record what the light client reports about one chain's peers.
 *
 * Fed from the protocol's sync stream rather than polled here, so it costs the
 * panel nothing. Unchanged counts are dropped: a steady connection reports the
 * same number every second and would repaint for nothing.
 */
export function recordPeerCount(role: ChainRole, peers: number): void {
  if (peerCounts.get(role) === peers) {
    return;
  }
  peerCounts.set(role, peers);
  notify();
}

/**
 * Record what the network is moving. Fed from the host's own byte meter and
 * the content download, so the panel neither samples nor counts anything of
 * its own.
 *
 * Merges rather than replaces: the speed and the download report on different
 * schedules, and an update from one must not blank the other.
 */
export function recordTransfer(next: Partial<TransferState>): void {
  const merged = { ...transfer, ...next };
  if (
    merged.bytesPerSecond === transfer.bytesPerSecond &&
    merged.fetched === transfer.fetched &&
    merged.total === transfer.total
  ) {
    return;
  }
  transfer = merged;
  notify();
}

/** What the network is moving right now. */
export function getTransfer(): TransferState {
  return transfer;
}

/**
 * Record a chain's bootstrap phase, as reported by the light client.
 *
 * Held apart from `chains` for the same reason peer counts are: it arrives on
 * the protocol's sync stream whether or not anyone has opened the panel.
 */
export function recordChainPhase(role: ChainRole, phase: ChainPhase): void {
  if (phases.get(role) === phase) {
    return;
  }
  phases.set(role, phase);
  notify();
}

/** Provide the transport. Call once, before the first watch. */
export function setBlockSource(next: BlockSource): void {
  source = next;
}

/**
 * Start watching, or cancel a pending teardown if already watching.
 *
 * Called when the panel opens. Chains already exist by then, because the globe
 * only appears once a product has loaded, so this adds subscriptions rather
 * than waking chains.
 */
export function startNetworkWatch(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!watching) {
    chains = new Map(
      getActiveChainRoles().map((role) => [
        role.role,
        { role, bars: [], latest: null, lastAt: null, unsubscribe: null },
      ]),
    );
    watching = true;
  }
  for (const state of chains.values()) {
    attach(state);
  }
}

/**
 * Stop watching after a grace period.
 *
 * History keeps accruing during the grace, so closing and reopening the panel
 * looks continuous. After it, subscriptions are dropped and the gap is left
 * visible rather than back-filled with guesses.
 */
export function stopNetworkWatch(): void {
  if (idleTimer !== null) {
    return;
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    detachAll();
  }, IDLE_GRACE_MS);
}

/** Drop everything at once, for teardown. */
export function endNetworkWatch(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  detachAll();
  watching = false;
}

/** Subscribe to any change in the tracked state. Returns an unsubscribe. */
export function subscribeNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A snapshot of every chain of the active network, in reading order. */
export function getNetworkStatus(): ChainStatus[] {
  const now = Date.now();
  const roles = watching
    ? [...chains.values()]
    : getActiveChainRoles().map((role) => ({
        role,
        bars: [] as BlockBar[],
        latest: null,
        lastAt: null,
        unsubscribe: null,
      }));
  return roles.map((state) => ({
    role: state.role.role,
    label: state.role.label,
    bars: state.bars,
    latest: state.latest,
    sinceLast: state.lastAt === null ? null : now - state.lastAt,
    blockTimeMs: state.role.blockTimeMs,
    reachable:
      state.role.hasEndpoint &&
      (source?.isReachable(state.role.genesis) ?? false),
    peers: peerCounts.get(state.role.role) ?? null,
    phase: phases.get(state.role.role) ?? null,
  }));
}

/** For tests. Drops all state and listeners. */
export function resetNetworkMonitor(): void {
  endNetworkWatch();
  chains = new Map();
  peerCounts = new Map();
  phases = new Map();
  transfer = { bytesPerSecond: null, fetched: null, total: null };
  listeners = new Set();
  source = null;
}
