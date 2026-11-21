// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Live per-chain state. It is told who holds each chain, its best blocks, phases and peers, and opens nothing itself.
// Arrival time is measured, not the block timestamp, because arrival is what this session actually has.

import { getActiveChainRoles, type ChainRole } from '@dotli/config';
import type { ChainActivity } from '@dotli/chains';
import { isRemoteChainConnectable } from '@dotli/protocol';
import { atom, type ReadableAtom } from 'nanostores';
import { realTimers, registerStoreStateReset, type Timers } from '@dotli/shared';

export type BlockHealth = 'onTime' | 'late' | 'veryLate';

export type BlockBar = {
  readonly number: number;
  readonly health: BlockHealth;
  /** Since the previous block arrived. */
  readonly gapMs: number;
};

/** How a chain counts toward the verdict. */
export type ChainUse = 'unused' | 'pending' | 'live';

export type ChainStatus = {
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
  /** The share of its last warp the light client proved, kept after the warp. Null before any. */
  readonly syncShare: number | null;
  /** Null where the backend never reports peers, such as a trusted provider. */
  readonly peers: number | null;
  readonly state: ChainUse;
  /** True when the chain is stalled, or down again after it was up. Never set by overdue blocks. */
  readonly alarm: boolean;
};

/** A chain's phase as it comes up, or `stalled` once it stops making progress. */
export type ChainPhase = 'connecting' | 'syncing' | 'ready' | 'stalled';

export type TransferState = {
  /** Across every chain socket, over a short window. */
  readonly bytesPerSecond: number | null;
  /** Bytes of the product archive fetched so far. */
  readonly fetched: number | null;
  /** Known once the content phase starts, null on a load served from cache. */
  readonly total: number | null;
};

export type ChainClock = Pick<
  ChainStatus,
  'label' | 'latest' | 'sinceLast' | 'blockTimeMs' | 'reachable' | 'state' | 'alarm'
>;

/** The live state of each chain and of the transfer. */
export type NetworkMonitor = ReturnType<typeof createNetworkMonitorState>;

type Params = {
  /** Whether the protocol frame can serve a known chain on the active network and backend. */
  isConnectable: (genesisHash: string) => boolean;
  /** The clock each block's arrival and each chain's time since its last block are measured on. */
  timers?: Pick<Timers, 'now'>;
};

type ChainState = {
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
  status: ChainActivity['status'];
  following: boolean;
  /** The pool reported `connected` while something held the chain, since it was last released. */
  poolWasConnected: boolean;
  /**
   * The frame's last report on a known chain. This and the two below outlive a release, since the frame's chains live on
   * whether or not this tab holds them.
   */
  phase: ChainPhase | null;
  syncShare: number | null;
  /** Null until the frame reports the count for a known chain. */
  peers: number | null;
  /**
   * A known chain the frame had up, so a drop is a regression. Set by a `ready` report or by a block while ready, and
   * cleared on a return to the page, so after a return only the next sign of life arms the alarm again.
   */
  frameWasReady: boolean;
};

/** The most bars a chain keeps. Only a memory ceiling, never how many are drawn. */
const MAX_BARS = 120;

/** Chains outside the known roles report no block time, so they are judged against a typical parachain's. */
const EXTRA_BLOCK_TIME_MS = 6000;

export function createNetworkMonitorState({ isConnectable, timers = realTimers }: Params) {
  let known: Map<string, ChainState> | null = null;
  const extras = new Map<string, ChainState>();
  let transfer = createIdleTransfer();
  const versionAtom = atom(0);
  const version: ReadableAtom<number> = versionAtom;
  registerStoreStateReset(() => {
    known = null;
    extras.clear();
    transfer = createIdleTransfer();
    // After the clears and never back to 0, so a computed over the model rebuilds from the cleared model and cannot
    // match a version it already built at.
    notify();
  });

  return {
    /** Counts the changes made to the model, so a follower reads it again when the count moves. */
    version,
    /**
     * Records who holds a chain and how its connection stands. A chain outside the known roles is listed only while
     * something holds it.
     */
    recordChainActivity,
    /**
     * Records a chain's best block. Ignored for a chain nobody holds, so a late block cannot revive a released chain's
     * history.
     */
    recordBestBlock,
    /**
     * Records a known chain's peer count. Unchanged counts are dropped, since a steady connection reports the same
     * number every second.
     */
    recordPeerCount,
    /**
     * Merges `next` into the transfer, because speed and download report on different schedules and one must not blank
     * the other. An unchanged transfer is dropped.
     */
    recordTransfer,
    /** Records a known chain's phase. An unchanged phase is dropped. */
    recordChainPhase,
    /** Records the share of its warp a known chain proved, from 0 to 1. An unchanged share is dropped. */
    recordSyncShare,
    /**
     * Records a return to the page, from hiding or from a sleep. Every chain's judgement starts over: its block clock
     * stops. A light client's alarm waits for its first block after the return, a pool's for its next `connected`, and a
     * pool still connected keeps its alarm. The bars stay.
     */
    recordReturn,
    /** Returns the transfer as last merged. */
    getTransfer,
    /**
     * Returns each chain's clock at `now`, the current time unless given. Copies no bars, so it stays cheap to read on
     * every change, content chunks included.
     */
    getChainClocks,
    /** Returns every known chain, then each other chain something holds, each with its own frozen copy of the bars. */
    getNetworkStatus,
  };

  function notify(): void {
    versionAtom.set(versionAtom.get() + 1);
  }

  /** Seeded on first use, so a network chosen before boot is the one listed. */
  function getKnownChains(): Map<string, ChainState> {
    known ??= new Map(
      getActiveChainRoles().map(role => {
        const genesis = role.genesis.toLowerCase();
        return [
          genesis,
          createChainState({
            key: role.role,
            role: role.role,
            label: role.label,
            genesis,
            blockTimeMs: role.blockTimeMs,
            hasEndpoint: role.hasEndpoint,
          }),
        ];
      }),
    );
    return known;
  }

  function findChain(genesisHash: string): ChainState | null {
    const genesis = genesisHash.toLowerCase();
    return getKnownChains().get(genesis) ?? extras.get(genesis) ?? null;
  }

  function findKnownChain(role: ChainRole): ChainState | null {
    return [...getKnownChains().values()].find(state => state.role === role) ?? null;
  }

  function recordBestBlock(genesisHash: string, blockNumber: number): void {
    const state = findChain(genesisHash);
    if (state === null || state.consumers === 0) {
      return;
    }
    // A reorg can repeat a number or go lower, and must not add a bar.
    if (state.latest !== null && blockNumber <= state.latest) {
      return;
    }
    const now = timers.now();
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
    // A block proves the chain is up again, so a later drop is a regression worth an alarm.
    if (state.phase === 'ready') {
      state.frameWasReady = true;
    }
    notify();
  }

  function recordReturn(): void {
    for (const state of listChains()) {
      state.lastAt = null;
      state.frameWasReady = false;
      if (state.status !== 'connected') {
        state.poolWasConnected = false;
      }
    }
    notify();
  }

  function recordChainActivity(activity: ChainActivity): void {
    const genesis = activity.genesisHash.toLowerCase();
    let state = findChain(genesis);
    if (state === null) {
      if (activity.consumers === 0) {
        return;
      }
      state = createChainState({
        key: genesis,
        role: null,
        label: shortenGenesis(genesis),
        genesis,
        blockTimeMs: EXTRA_BLOCK_TIME_MS,
        hasEndpoint: true,
      });
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

  function recordPeerCount(role: ChainRole, peers: number): void {
    const state = findKnownChain(role);
    if (state === null || state.peers === peers) {
      return;
    }
    state.peers = peers;
    notify();
  }

  function recordTransfer(next: Partial<TransferState>): void {
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

  function getTransfer(): TransferState {
    return transfer;
  }

  function recordChainPhase(role: ChainRole, phase: ChainPhase): void {
    const state = findKnownChain(role);
    if (state === null) {
      return;
    }
    if (phase === 'ready') {
      state.frameWasReady = true;
    }
    if (state.phase === phase) {
      return;
    }
    state.phase = phase;
    notify();
  }

  function recordSyncShare(role: ChainRole, share: number): void {
    const state = findKnownChain(role);
    if (state === null || state.syncShare === share) {
      return;
    }
    state.syncShare = share;
    notify();
  }

  function isReachable(state: ChainState): boolean {
    return state.hasEndpoint && (state.role === null || isConnectable(state.genesis));
  }

  /**
   * How a chain counts toward the verdict, and whether it is stalled or down again after it was up. Overdue blocks are
   * not judged here.
   */
  function judgeUse(state: ChainState, sinceLast: number | null): Pick<ChainStatus, 'state' | 'alarm'> {
    if (!isReachable(state)) {
      return { state: 'unused', alarm: false };
    }
    if (isAlarmed(state)) {
      return { state: 'live', alarm: true };
    }
    // The frame brings its chains up whether or not this tab holds them, so a chain only turns pending once taken.
    if (state.consumers === 0) {
      return { state: 'unused', alarm: false };
    }
    if (state.following) {
      return { state: sinceLast === null ? 'pending' : 'live', alarm: false };
    }
    return { state: isPhaseDown(state.phase) || state.status !== 'connected' ? 'pending' : 'live', alarm: false };
  }

  /** Whether the chain is stalled while in use, or down again after it was up. */
  function isAlarmed(state: ChainState): boolean {
    const inUse = state.consumers > 0;
    // The frame judges the chains it reports on, the pool the rest.
    if (state.phase === null) {
      return inUse && state.poolWasConnected && state.status !== 'connected';
    }
    if (inUse && state.phase === 'stalled') {
      return true;
    }
    return isPhaseDown(state.phase) && state.frameWasReady;
  }

  function listChains(): ChainState[] {
    return [...getKnownChains().values(), ...extras.values()];
  }

  function readClock(state: ChainState, now: number): ChainClock {
    const sinceLast = state.lastAt === null ? null : now - state.lastAt;
    return {
      label: state.label,
      latest: state.latest,
      sinceLast,
      blockTimeMs: state.blockTimeMs,
      reachable: isReachable(state),
      ...judgeUse(state, sinceLast),
    };
  }

  function getChainClocks(now: number = timers.now()): ChainClock[] {
    return listChains().map(state => readClock(state, now));
  }

  function getNetworkStatus(): ChainStatus[] {
    const now = timers.now();
    return listChains().map(state => ({
      ...readClock(state, now),
      key: state.key,
      role: state.role,
      // A copy, since the monitor mutates its own array in place.
      bars: Object.freeze([...state.bars]),
      peers: state.peers,
      phase: state.phase,
      syncShare: state.syncShare,
    }));
  }
}

/** The page's, on the page's own clock. */
export const networkMonitorState: NetworkMonitor = createNetworkMonitorState({
  isConnectable: isRemoteChainConnectable,
});

/** Returns how a block arrival `gapMs` after the previous one reads against `blockTimeMs`. */
function classifyGap(gapMs: number, blockTimeMs: number): BlockHealth {
  if (gapMs <= blockTimeMs * 1.5) {
    return 'onTime';
  }
  return gapMs <= blockTimeMs * 3 ? 'late' : 'veryLate';
}

function isPhaseDown(phase: ChainPhase | null): boolean {
  return phase === 'connecting' || phase === 'syncing';
}

function createChainState(
  identity: Pick<ChainState, 'key' | 'role' | 'label' | 'genesis' | 'blockTimeMs' | 'hasEndpoint'>,
): ChainState {
  return {
    ...identity,
    bars: [],
    latest: null,
    lastAt: null,
    consumers: 0,
    status: 'disconnected',
    following: false,
    poolWasConnected: false,
    phase: null,
    syncShare: null,
    peers: null,
    frameWasReady: false,
  };
}

function createIdleTransfer(): TransferState {
  return { bytesPerSecond: null, fetched: null, total: null };
}

function shortenGenesis(genesis: string): string {
  return `${genesis.slice(0, 6)}…${genesis.slice(-4)}`;
}
