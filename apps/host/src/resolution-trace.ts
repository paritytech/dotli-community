// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Collects the protocol iframe's and the sandbox's reports into one Sentry trace per page load. Built live, since a
// load that never finishes is the one worth looking at.

import type { ChainKey, ChainPeer, ChainSyncKind } from '@dotli/resolver';
import type { ChainPhase } from '@dotli/ui';
import { m, type SpanHandle, type SpanValue } from '@dotli/metrics';
import { peekContinuation } from '@dotli/shared';
import { getLoadingState } from '@dotli/ui';
import type { Attempt } from './journey.js';

/**
 * Judged by what the visitor got: `rendered` is content on screen, not a mounted iframe. `no_content` is a name with
 * nothing published on this network, `content_error` a sandbox that could not load what is.
 */
export type ResolutionOutcome = 'rendered' | 'no_content' | 'error' | 'content_error' | 'abandoned';

export type CacheResult = 'hit' | 'miss';

/** `skipped` is a lookup the settings turned off. */
export type CidCacheResult = CacheResult | 'skipped';

export interface FinishDetails {
  /** For reading, never grouped on. */
  reason?: string;
  /** The stable classification the error page was chosen from. */
  errorKind?: string;
  failedStep?: string;
}

type Phase = 'connecting' | 'syncing' | 'ready';

/**
 * Shared with the loading screen so the two never classify a chain differently. Milestones that name no phase are
 * absent, so a lone peer count never moves the chain.
 */
export const PHASE_BY_MILESTONE: Partial<Record<ChainSyncKind, ChainPhase>> = {
  connecting: 'connecting',
  warpSyncProgress: 'syncing',
  warpSyncFinished: 'ready',
  bootstrapComplete: 'ready',
  stalled: 'stalled',
};

/** Share of loads that get child spans. The root always carries every measurement, so nothing is lost. */
const DEFAULT_SAMPLE_RATE = 0.2;

function sampleRate(): number {
  const raw = Number(import.meta.env.VITE_RESOLUTION_SAMPLE_RATE ?? '');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_SAMPLE_RATE;
}

/** Decided at the start, since Sentry fixes a trace's sampling when its root opens. */
function sampleFor(): boolean {
  return Math.random() < sampleRate();
}

interface ChainState {
  span: SpanHandle | null;
  phaseSpan: SpanHandle | null;
  phase: Phase | null;
  firstPeerMs: number | null;
  readyMs: number | null;
  peersMax: number;
  stallCount: number;
  stallReasons: Set<string>;
  warpFrom: number | null;
  warpAt: number | null;
  warpTarget: number | null;
  dbCache: CacheResult | null;
  peers: ChainPeer[] | null;
}

function newChainState(): ChainState {
  return {
    span: null,
    phaseSpan: null,
    phase: null,
    firstPeerMs: null,
    readyMs: null,
    peersMax: 0,
    stallCount: 0,
    stallReasons: new Set(),
    warpFrom: null,
    warpAt: null,
    warpTarget: null,
    dbCache: null,
    peers: null,
  };
}

export interface ChainSyncFacts {
  chain: ChainKey;
  syncKind: ChainSyncKind;
  peers?: number;
  reason?: string;
  at?: number;
  target?: number;
}

export interface ResolutionTrace {
  chainSync: (event: ChainSyncFacts) => void;
  /** A telemetry-only fact about one chain. */
  chainDetail: (event: { chain: ChainKey; dbCache?: CacheResult; peers?: ChainPeer[] }) => void;
  /** Cumulative bytes the light client has pulled off the network. */
  bytes: (received: number) => void;
  content: (fetched: number, total: number | null) => void;
  nameResolved: (cid: string | null) => void;
  cidCache: (result: CidCacheResult) => void;
  /** Reported as `loading_phase` wherever the load ends. */
  step: (name: string) => void;
  /** The sandbox iframe is mounted and the download is its to run. */
  handedOff: () => void;
  warningShown: () => void;
  /** Idempotent: the first outcome wins. */
  finish: (outcome: ResolutionOutcome, details?: FinishDetails) => void;
  /** For linking this load's errors to its trace. */
  span: SpanHandle;
}

export interface ResolutionTraceOptions {
  domain: string;
  network: string;
  backend: string;
  attempt: Attempt;
  /** `performance.now()` at page load. The root is backdated here to cover boot work before the label is known. */
  startedAt: number;
}

/** Safe when metrics are stripped: every span handle is inert. */
export function startResolutionTrace(opts: ResolutionTraceOptions): ResolutionTrace {
  // Monotonic deltas from one wall-clock start, so a system clock that steps mid-load cannot reorder the tree.
  const perfStart = opts.startedAt;
  const epochStart = Date.now() - (performance.now() - perfStart);
  const at = (): number => epochStart + (performance.now() - perfStart);
  const sinceStart = (): number => performance.now() - perfStart;

  const sampled = sampleFor();

  const root = m.open('resolution', {
    root: true,
    startTime: epochStart,
    attributes: {
      domain: opts.domain,
      network: opts.network,
      backend: opts.backend,
      sampled_children: sampled,
      journey_id: opts.attempt.journeyId,
      attempt_number: opts.attempt.attemptNumber,
      entry: opts.attempt.entry,
    },
  });

  const chains = new Map<ChainKey, ChainState>();
  const chainOf = (key: ChainKey): ChainState => {
    let state = chains.get(key);
    if (state === undefined) {
      state = newChainState();
      // Opens when the chain is first heard from, or Bulletin, created only for content, would look idle, not absent.
      state.span = sampled ? root.child(`chain.${key}`, { startTime: at() }) : null;
      chains.set(key, state);
    }
    return state;
  };

  // Taken while the loading screen was still being driven.
  let lastBarPercent: number | null = null;
  const sampleBar = (): void => {
    const seen = readBarPercent();
    if (seen > 0) {
      lastBarPercent = seen;
    }
  };

  let bytesTotal = 0;
  let peakBytesPerSecond = 0;
  let lastBytes = 0;
  let lastBytesAt = perfStart;
  let contentBytes = 0;
  let contentTotal: number | null = null;
  let cid: string | null = null;
  let cidCacheResult: CidCacheResult | null = null;
  let nameResolvedMs: number | null = null;
  let handoffMs: number | null = null;
  let loadingPhase = 'boot';
  let warned = false;
  let nameSpan: SpanHandle | null = sampled ? root.child('name_resolution', { startTime: epochStart }) : null;
  let contentSpan: SpanHandle | null = null;
  let finished = false;

  const enterPhase = (key: ChainKey, state: ChainState, phase: Phase): void => {
    if (state.phase === phase) {
      return;
    }
    state.phaseSpan?.end(at());
    state.phase = phase;
    // Named in full, since `child` does not inherit the parent's name and every chain would report `dotli.ready`.
    state.phaseSpan = state.span === null ? null : state.span.child(`chain.${key}.${phase}`, { startTime: at() });
  };

  const trace: ResolutionTrace = {
    chainSync: event => {
      if (finished) {
        return;
      }
      const state = chainOf(event.chain);
      const phase = PHASE_BY_MILESTONE[event.syncKind];
      // A stall interrupts a phase rather than being one, so it is an attribute, not a span.
      if (phase !== undefined && phase !== 'stalled') {
        enterPhase(event.chain, state, phase);
      }
      switch (event.syncKind) {
        case 'peers':
          if (typeof event.peers === 'number') {
            state.peersMax = Math.max(state.peersMax, event.peers);
          }
          break;
        case 'firstPeer':
          state.firstPeerMs ??= sinceStart();
          break;
        case 'bootstrapComplete':
          state.readyMs ??= sinceStart();
          break;
        case 'stalled':
          state.stallCount += 1;
          if (event.reason !== undefined) {
            state.stallReasons.add(event.reason);
          }
          break;
        case 'warpSyncProgress':
          if (typeof event.at === 'number') {
            state.warpFrom ??= event.at;
            state.warpAt = event.at;
          }
          if (typeof event.target === 'number') {
            state.warpTarget = event.target;
          }
          break;
        case 'connecting':
        case 'recovered':
        case 'warpSyncFinished':
          // The phase mapping above handles these.
          break;
      }
    },

    chainDetail: event => {
      if (finished) {
        return;
      }
      const state = chainOf(event.chain);
      if (event.dbCache !== undefined) {
        // First answer wins: the second Bulletin connection always misses.
        state.dbCache ??= event.dbCache;
      }
      if (event.peers !== undefined) {
        state.peers = event.peers;
      }
    },

    bytes: received => {
      if (finished || !Number.isFinite(received) || received < lastBytes) {
        return;
      }
      bytesTotal = received;
      sampleBar();
      const now = performance.now();
      const elapsed = now - lastBytesAt;
      // The seed reading is page start with nothing downloaded, so the first report already has a partner.
      if (elapsed > 0) {
        const rate = ((received - lastBytes) / elapsed) * 1000;
        peakBytesPerSecond = Math.max(peakBytesPerSecond, rate);
      }
      lastBytes = received;
      lastBytesAt = now;
    },

    content: (fetched, total) => {
      if (finished) {
        return;
      }
      sampleBar();
      contentSpan ??= sampled ? root.child('content_fetch', { startTime: at() }) : null;
      contentBytes = fetched;
      contentTotal = total;
    },

    nameResolved: resolved => {
      if (finished) {
        return;
      }
      cid = resolved;
      nameResolvedMs ??= sinceStart();
      nameSpan?.setAttributes({
        cid: resolved ?? 'none',
        duration_ms: nameResolvedMs,
      });
      nameSpan?.end(at());
      nameSpan = null;
    },

    cidCache: result => {
      cidCacheResult = result;
    },

    step: name => {
      loadingPhase = name;
    },

    handedOff: () => {
      handoffMs ??= sinceStart();
    },

    warningShown: () => {
      warned = true;
    },

    span: root,

    finish: (outcome, details) => {
      if (finished) {
        return;
      }
      finished = true;
      const endedAt = at();
      const totalMs = sinceStart();

      nameSpan?.end(endedAt);
      for (const [key, state] of chains) {
        state.phaseSpan?.end(endedAt);
        state.span?.setAttributes(chainAttributes(key, state));
        state.span?.end(endedAt);
      }
      contentSpan?.setAttributes({
        bytes: contentBytes,
        ...(contentTotal !== null ? { total_bytes: contentTotal } : {}),
      });
      contentSpan?.end(endedAt);

      root.setAttributes({
        outcome,
        total_ms: totalMs,
        bytes_total: bytesTotal,
        avg_bytes_per_second: totalMs > 0 ? (bytesTotal / totalMs) * 1000 : 0,
        peak_bytes_per_second: peakBytesPerSecond,
        bar_at_render: lastBarPercent ?? readBarPercent(),
        tab_visible: document.visibilityState === 'visible',
        ...(cid !== null ? { cid } : {}),
        ...(cidCacheResult !== null ? { cid_cache: cidCacheResult } : {}),
        ...(nameResolvedMs !== null ? { name_resolution_ms: nameResolvedMs } : {}),
        ...(handoffMs !== null ? { handoff_ms: handoffMs } : {}),
        loading_phase: loadingPhase,
        warning_shown: warned,
        ...(details?.reason !== undefined ? { failure_reason: details.reason.slice(0, 200) } : {}),
        ...(details?.errorKind !== undefined ? { error_kind: details.errorKind } : {}),
        ...(details?.failedStep !== undefined ? { failed_step: details.failedStep } : {}),
        // An unsampled load still answers "which chain was slow".
        ...chainSummary(chains),
      });
      root.end(endedAt);
    },
  };

  // Otherwise a tab closed mid-resolution never sends its root span. A browser reload, a typed URL and a closed tab
  // all read "unload" here, and the next attempt's `entry` tells a reload apart.
  window.addEventListener('pagehide', (event: PageTransitionEvent) => {
    if (finished) {
      return;
    }
    root.setAttributes({ exit: event.persisted ? 'bfcache' : (peekContinuation() ?? 'unload') });
    trace.finish('abandoned');
  });

  return trace;
}

/** From the loading store, not the bar's markup, so a load whose loading island never mounted still reports it. */
function readBarPercent(): number {
  return getLoadingState().progress;
}

function chainAttributes(key: ChainKey, state: ChainState): Record<string, SpanValue> {
  const attrs: Record<string, SpanValue> = {
    chain: key,
    peers_max: state.peersMax,
    stall_count: state.stallCount,
  };
  if (state.dbCache !== null) {
    attrs['db_cache'] = state.dbCache;
  }
  if (state.firstPeerMs !== null) {
    attrs['time_to_first_peer_ms'] = state.firstPeerMs;
  }
  if (state.readyMs !== null) {
    attrs['time_to_ready_ms'] = state.readyMs;
  }
  if (state.stallReasons.size > 0) {
    attrs['stall_reasons'] = [...state.stallReasons].join(',');
  }
  if (state.warpTarget !== null) {
    attrs['warp_target'] = state.warpTarget;
    if (state.warpAt !== null) {
      attrs['warp_at'] = state.warpAt;
    }
    if (state.warpFrom !== null && state.warpAt !== null) {
      attrs['warp_from'] = state.warpFrom;
      attrs['warp_blocks'] = state.warpAt - state.warpFrom;
    }
  }
  const peers = state.peers ?? [];
  const heights = peers.map(peer => peer.bestNumber).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  if (median !== undefined) {
    attrs['peers_count'] = peers.length;
    attrs['peers_authority'] = peers.filter(peer => peer.roles === 'AUTHORITY').length;
    attrs['peers_best_median'] = median;
    // Public identities of infrastructure nodes from the chain specs, never the visitor's.
    attrs['peers_ids'] = peers
      .map(peer => peer.peerId)
      .join(',')
      .slice(0, 1000);
    if (state.warpTarget !== null) {
      // A lag near zero says the network was fine and the time went elsewhere.
      attrs['peer_best_lag'] = state.warpTarget - median;
    }
  }
  return attrs;
}

/** Flattened for the root, so an unsampled load still has them. */
function chainSummary(chains: ReadonlyMap<ChainKey, ChainState>): Record<string, SpanValue> {
  const out: Record<string, SpanValue> = {};
  for (const [key, state] of chains) {
    if (state.readyMs !== null) {
      out[`chain.${key}.ready_ms`] = state.readyMs;
    }
    if (state.dbCache !== null) {
      out[`chain.${key}.db_cache`] = state.dbCache;
    }
    if (state.peersMax > 0) {
      out[`chain.${key}.peers_max`] = state.peersMax;
    }
  }
  return out;
}
