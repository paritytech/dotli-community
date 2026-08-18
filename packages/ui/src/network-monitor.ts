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
}

/** Bars kept per chain, about four minutes of relay at 6s. */
const MAX_BARS = 40;

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
  }));
}

/** For tests. Drops all state and listeners. */
export function resetNetworkMonitor(): void {
  endNetworkWatch();
  chains = new Map();
  listeners = new Set();
  source = null;
}
