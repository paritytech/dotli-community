// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Live per-chain state for the network panel. The host chain pool pushes who holds each chain and its best blocks,
// the protocol frame pushes phases and peers, and the monitor opens nothing itself. Arrival time is measured, not the
// block timestamp, because arrival is what this session actually has.

import { getActiveChainRoles, type ChainRole } from '@dotli/config';
import { isRemoteChainConnectable, type ChainActivity } from '@dotli/protocol';

export type BlockHealth = 'onTime' | 'late' | 'veryLate';

export interface BlockBar {
  readonly number: number;
  readonly health: BlockHealth;
  /** Since the previous block arrived. */
  readonly gapMs: number;
}

/** How a chain counts toward the verdict. */
export type ChainUse = 'unused' | 'pending' | 'live';

export interface ChainStatus {
  /** The role of a known chain, the genesis hash of any other. */
  readonly key: string;
  /** Null for a chain outside the known roles. */
  readonly role: ChainRole | null;
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
  readonly state: ChainUse;
  /** Stalled, or down again after it was up. Overdue blocks are the verdict's to judge. */
  readonly alarm: boolean;
}

// Only a memory ceiling. The panel renders as many as its width fits, and this must never decide that.
const MAX_BARS = 120;

/** Chains outside the known roles report no block time, so they are judged against a typical parachain's. */
const EXTRA_BLOCK_TIME_MS = 6000;

export function classifyGap(gapMs: number, blockTimeMs: number): BlockHealth {
  if (gapMs <= blockTimeMs * 1.5) {
    return 'onTime';
  }
  return gapMs <= blockTimeMs * 3 ? 'late' : 'veryLate';
}

type PoolStatus = ChainActivity['status'];

interface ChainState {
  readonly key: string;
  readonly role: ChainRole | null;
  readonly label: string;
  readonly genesis: string;
  readonly blockTimeMs: number;
  readonly hasEndpoint: boolean;
  bars: BlockBar[];
  latest: number | null;
  lastAt: number | null;
  consumers: number;
  status: PoolStatus;
  following: boolean;
  /** The pool reported `connected` while something held the chain, since it was last released. */
  poolWasConnected: boolean;
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

let known: Map<string, ChainState> | null = null;
let extras = new Map<string, ChainState>();
let peerCounts = new Map<ChainRole, number>();
let phases = new Map<ChainRole, ChainPhase>();
// Never cleared, because the frame's chains live on whether or not this tab holds them.
let frameWasReady = new Set<ChainRole>();
let transfer: TransferState = {
  bytesPerSecond: null,
  fetched: null,
  total: null,
};
let listeners = new Set<() => void>();

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

function idleUse(): Pick<
  ChainState,
  'bars' | 'latest' | 'lastAt' | 'consumers' | 'status' | 'following' | 'poolWasConnected'
> {
  return {
    bars: [],
    latest: null,
    lastAt: null,
    consumers: 0,
    status: 'disconnected',
    following: false,
    poolWasConnected: false,
  };
}

/** Seeded on first use, so a network chosen before boot is the one listed. */
function knownChains(): Map<string, ChainState> {
  known ??= new Map(
    getActiveChainRoles().map(role => {
      const genesis = role.genesis.toLowerCase();
      return [
        genesis,
        {
          key: role.role,
          role: role.role,
          label: role.label,
          genesis,
          blockTimeMs: role.blockTimeMs,
          hasEndpoint: role.hasEndpoint,
          ...idleUse(),
        },
      ];
    }),
  );
  return known;
}

function findChain(genesisHash: string): ChainState | undefined {
  const genesis = genesisHash.toLowerCase();
  return knownChains().get(genesis) ?? extras.get(genesis);
}

function shortGenesis(genesis: string): string {
  return `${genesis.slice(0, 6)}…${genesis.slice(-4)}`;
}

function recordBlock(state: ChainState, blockNumber: number): void {
  // A reorg can repeat a number or go lower, and must not add a bar.
  if (state.latest !== null && blockNumber <= state.latest) {
    return;
  }
  const now = Date.now();
  // The first block has no gap to judge, so it only anchors the next one.
  if (state.lastAt !== null) {
    const gapMs = now - state.lastAt;
    state.bars.push({
      number: blockNumber,
      health: classifyGap(gapMs, state.blockTimeMs),
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

/** From the host chain pool. A chain outside the known roles is listed only while something holds it. */
export function recordChainActivity(activity: ChainActivity): void {
  const genesis = activity.genesisHash.toLowerCase();
  let state = findChain(genesis);
  if (state === undefined) {
    if (activity.consumers === 0) {
      return;
    }
    state = {
      key: genesis,
      role: null,
      label: shortGenesis(genesis),
      genesis,
      blockTimeMs: EXTRA_BLOCK_TIME_MS,
      hasEndpoint: true,
      ...idleUse(),
    };
    extras.set(genesis, state);
  }
  const released = state.consumers > 0 && activity.consumers === 0;
  // A consumer can drop its follow and keep the chain. No block is coming then, so the clock stops rather than
  // reading the chain as overdue, and a later follow carries the strip on from its next block.
  if (state.following && !activity.following) {
    state.lastAt = null;
  }
  state.consumers = activity.consumers;
  state.status = activity.status;
  state.following = activity.following;
  if (activity.consumers > 0 && activity.status === 'connected') {
    state.poolWasConnected = true;
  }
  if (released) {
    if (state.role === null) {
      extras.delete(genesis);
    } else {
      // The bars stay as the record of its last use. The clock stops, so a chain held again is judged from its next
      // block rather than read as overdue, and the unused stretch draws no bar.
      state.lastAt = null;
      state.poolWasConnected = false;
    }
  }
  notify();
}

/** Ignored for a chain nobody holds, so a late block cannot revive a released chain's history. */
export function recordBestBlock(genesisHash: string, blockNumber: number): void {
  const state = findChain(genesisHash);
  if (state !== undefined && state.consumers > 0) {
    recordBlock(state, blockNumber);
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
  if (phase === 'ready') {
    frameWasReady.add(role);
  }
  if (phases.get(role) === phase) {
    return;
  }
  phases.set(role, phase);
  notify();
}

export function subscribeNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type ChainClock = Pick<
  ChainStatus,
  'label' | 'latest' | 'sinceLast' | 'blockTimeMs' | 'reachable' | 'state' | 'alarm'
>;

function isReachable(state: ChainState): boolean {
  return state.hasEndpoint && (state.role === null || isRemoteChainConnectable(state.genesis));
}

/**
 * How a chain counts toward the verdict, and whether it is stalled or down again after it was up. Overdue blocks are
 * left to the verdict, which also schedules the recheck.
 */
function useOf(state: ChainState, sinceLast: number | null): Pick<ChainStatus, 'state' | 'alarm'> {
  if (!isReachable(state)) {
    return { state: 'unused', alarm: false };
  }
  const phase = state.role === null ? undefined : phases.get(state.role);
  const inUse = state.consumers > 0;
  const phaseDown = phase === 'connecting' || phase === 'syncing';
  const poolDown = state.status !== 'connected';
  // The frame judges the chains it reports on, the pool the rest.
  const regressed =
    phase === undefined
      ? inUse && state.poolWasConnected && poolDown
      : phaseDown && state.role !== null && frameWasReady.has(state.role);
  if (regressed || (inUse && phase === 'stalled')) {
    return { state: 'live', alarm: true };
  }
  if (!inUse) {
    return { state: phaseDown ? 'pending' : 'unused', alarm: false };
  }
  if (state.following) {
    return { state: sinceLast === null ? 'pending' : 'live', alarm: false };
  }
  return { state: phaseDown || poolDown ? 'pending' : 'live', alarm: false };
}

function allChains(): ChainState[] {
  return [...knownChains().values(), ...extras.values()];
}

function clockOf(state: ChainState, now: number): ChainClock {
  const sinceLast = state.lastAt === null ? null : now - state.lastAt;
  return {
    label: state.label,
    latest: state.latest,
    sinceLast,
    blockTimeMs: state.blockTimeMs,
    reachable: isReachable(state),
    ...useOf(state, sinceLast),
  };
}

/** Copies no bars, because the health judges on every notify, content chunks included. */
export function getChainClocks(now: number = Date.now()): ChainClock[] {
  return allChains().map(state => clockOf(state, now));
}

export function getNetworkStatus(): ChainStatus[] {
  const now = Date.now();
  return allChains().map(state => ({
    ...clockOf(state, now),
    key: state.key,
    role: state.role,
    // A copy, since the monitor mutates its own array in place.
    bars: Object.freeze([...state.bars]),
    peers: state.role === null ? null : (peerCounts.get(state.role) ?? null),
    phase: state.role === null ? null : (phases.get(state.role) ?? null),
  }));
}

/** For tests. */
export function resetNetworkMonitor(): void {
  known = null;
  extras = new Map();
  peerCounts = new Map();
  phases = new Map();
  frameWasReady = new Set();
  transfer = { bytesPerSecond: null, fetched: null, total: null };
  listeners = new Set();
}
