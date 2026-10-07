// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Live per-chain block arrivals for the network panel. Arrival time is measured, not the block
// timestamp, because arrival is what this session actually has.

import { getActiveChainRoles, type ActiveChainRole, type ChainRole } from '@dotli/config';
import { log } from '@dotli/shared';

export type BlockHealth = 'onTime' | 'late' | 'veryLate';

export interface BlockBar {
  readonly number: number;
  readonly health: BlockHealth;
  /** Since the previous block arrived. */
  readonly gapMs: number;
}

export interface ChainStatus {
  readonly role: ChainRole;
  readonly label: string;
  /** Oldest first. */
  readonly bars: readonly BlockBar[];
  readonly latest: number | null;
  readonly sinceLast: number | null;
  readonly blockTimeMs: number;
  /** False when the active network offers no endpoint for this chain. */
  readonly reachable: boolean;
  /** A chain can be `ready` before any block is observed. */
  readonly phase: ChainPhase | null;
  /** Null where the backend never reports peers, such as a trusted provider. */
  readonly peers: number | null;
}

// Only a memory ceiling. The panel renders as many as its width fits, and this must never decide that.
const MAX_BARS = 120;

// Short enough that an unwatched panel holds no chain connections, which are capped across tabs in
// shared-worker mode.
const IDLE_GRACE_MS = 60_000;

export function classifyGap(gapMs: number, blockTimeMs: number): BlockHealth {
  if (gapMs <= blockTimeMs * 1.5) {
    return 'onTime';
  }
  return gapMs <= blockTimeMs * 3 ? 'late' : 'veryLate';
}

interface ChainState {
  role: ActiveChainRole;
  bars: BlockBar[];
  latest: number | null;
  lastAt: number | null;
  unsubscribe: (() => void) | null;
}

/** `stalled` comes from the watchdog, alongside the light client's lifecycle phase. */
export type ChainPhase = 'connecting' | 'syncing' | 'ready' | 'stalled';

export interface TransferState {
  /** Across every chain socket, over a short window. */
  readonly bytesPerSecond: number | null;
  /** Bytes of the product archive fetched so far. */
  readonly fetched: number | null;
  /** Known once the content phase starts, null on a load served from cache. */
  readonly total: number | null;
}

/** Injected so tests can drive it. */
export interface BlockSource {
  subscribe: (genesis: string, onBlock: (blockNumber: number) => void) => () => void;
  isReachable: (genesis: string) => boolean;
}

let source: BlockSource | null = null;
let chains = new Map<ChainRole, ChainState>();
// Apart from `chains` because peer counts and phases arrive whether or not the panel is open, and
// outlive a watch torn down after the idle grace.
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
let holds = 0;

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
      // eslint-disable-next-line no-restricted-syntax -- one bad renderer must not stop the others.
    } catch {
      // Listener threw.
    }
  }
}

function recordBlock(state: ChainState, blockNumber: number): void {
  // `bestBlocks$` also re-emits the same head on a new descendant, a finalization or a reorg.
  if (state.latest !== null && blockNumber <= state.latest) {
    return;
  }
  const now = Date.now();
  // The first block has no gap to judge, so it only anchors the next one.
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
    state.unsubscribe = source.subscribe(state.role.genesis, blockNumber => {
      recordBlock(state, blockNumber);
    });
  } catch (err: unknown) {
    log.warn(`[dot.li network] could not watch ${state.role.role}:`, err);
  }
}

function detachAll(): void {
  for (const state of chains.values()) {
    state.unsubscribe?.();
    state.unsubscribe = null;
  }
}

/** Unchanged counts are dropped, since a steady connection reports the same number every second. */
export function recordPeerCount(role: ChainRole, peers: number): void {
  if (peerCounts.get(role) === peers) {
    return;
  }
  peerCounts.set(role, peers);
  notify();
}

/** Merges, because speed and download report on different schedules and one must not blank the other. */
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

export function getTransfer(): TransferState {
  return transfer;
}

export function recordChainPhase(role: ChainRole, phase: ChainPhase): void {
  if (phases.get(role) === phase) {
    return;
  }
  phases.set(role, phase);
  notify();
}

/** Call once, before the first watch. */
export function setBlockSource(next: BlockSource): void {
  source = next;
}

/** Cancels a pending teardown when already watching. */
export function startNetworkWatch(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!watching) {
    chains = new Map(
      getActiveChainRoles().map(role => [role.role, { role, bars: [], latest: null, lastAt: null, unsubscribe: null }]),
    );
    watching = true;
  }
  for (const state of chains.values()) {
    attach(state);
  }
}

/** After the grace, the gap is left visible rather than back-filled with guesses. */
export function stopNetworkWatch(): void {
  if (idleTimer !== null) {
    return;
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    detachAll();
  }, IDLE_GRACE_MS);
}

export function endNetworkWatch(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  detachAll();
  watching = false;
}

/** Refcounted so one reader closing does not drop another's subscriptions. Releasing twice counts once. */
export function holdNetworkWatch(): () => void {
  holds += 1;
  startNetworkWatch();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    holds -= 1;
    if (holds === 0) {
      stopNetworkWatch();
    }
  };
}

export function subscribeNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type ChainClock = Pick<ChainStatus, 'label' | 'latest' | 'sinceLast' | 'blockTimeMs' | 'reachable'>;

function currentChains(): readonly ChainState[] {
  return watching
    ? [...chains.values()]
    : getActiveChainRoles().map(role => ({
        role,
        bars: [],
        latest: null,
        lastAt: null,
        unsubscribe: null,
      }));
}

function clockOf(state: ChainState, now: number): ChainClock {
  return {
    label: state.role.label,
    latest: state.latest,
    sinceLast: state.lastAt === null ? null : now - state.lastAt,
    blockTimeMs: state.role.blockTimeMs,
    reachable: state.role.hasEndpoint && (source?.isReachable(state.role.genesis) ?? false),
  };
}

/** Copies no bars, because the health judges on every notify, content chunks included. */
export function getChainClocks(now: number = Date.now()): ChainClock[] {
  return currentChains().map(state => clockOf(state, now));
}

export function getNetworkStatus(): ChainStatus[] {
  const now = Date.now();
  return currentChains().map(state => ({
    ...clockOf(state, now),
    role: state.role.role,
    // A copy, since the monitor mutates its own array in place.
    bars: Object.freeze([...state.bars]),
    peers: peerCounts.get(state.role.role) ?? null,
    phase: phases.get(state.role.role) ?? null,
  }));
}

/** For tests. */
export function resetNetworkMonitor(): void {
  endNetworkWatch();
  holds = 0;
  chains = new Map();
  peerCounts = new Map();
  phases = new Map();
  transfer = { bytesPerSecond: null, fetched: null, total: null };
  listeners = new Set();
  source = null;
}
