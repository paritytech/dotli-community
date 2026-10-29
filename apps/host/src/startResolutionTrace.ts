// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Collects the protocol iframe's and the sandbox's reports into one Sentry trace per page load. Built live, since a
// load that never finishes is the one worth looking at.

import type { ChainDetail, ChainPeer, ChainSyncEvent } from '@dotli/chains';
import type { ChainRole } from '@dotli/config';
import { m, type SpanHandle, type SpanValue } from '@dotli/metrics';
import { realTimers, type Timers } from '@dotli/shared';
import { continuation, type Continuation } from './createContinuation.js';
import { PHASE_BY_MILESTONE } from './phaseByMilestone.js';
import { getChainTelemetryName } from './getChainTelemetryName.js';
import { loadingState } from './state/loadingState.js';
import type { Attempt } from './journey.js';
import { readPageClock } from './readPageClock.js';

/**
 * Judged by what the visitor got: `rendered` is content on screen, not a mounted iframe. `no_content` is a name with
 * nothing published on this network, `content_error` a sandbox that could not load what is.
 */
export type ResolutionOutcome = 'rendered' | 'no_content' | 'error' | 'content_error' | 'abandoned';

export type CacheResult = 'hit' | 'miss';

/** `skipped` is a lookup the settings turned off. */
export type CidCacheResult = CacheResult | 'skipped';

export type FinishDetails = {
  /** For reading, never grouped on. */
  reason?: string;
  /** The stable classification the error page was chosen from. */
  errorKind?: string;
  failedStep?: string;
};

type Phase = 'connecting' | 'syncing' | 'ready';

type ChainState = {
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
};

export type ResolutionTrace = ReturnType<typeof startResolutionTrace>;

/** What the trace reads from the page it runs in. */
export type TracedPage = {
  /** Fires `pagehide` when the visitor leaves. */
  lifecycle: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Returns whether the tab is in view. Never throws. */
  isVisible: () => boolean;
  /** Returns the loading bar's percent, as the visitor sees it. Never throws. */
  readProgress: () => number;
  /** Returns the reason the app gave for its own reload, or null when it gave none. Never throws. */
  peekContinuation: () => Continuation | null;
};

export type ResolutionTraceParams = {
  domain: string;
  network: string;
  backend: string;
  attempt: Attempt;
  /** `now` at page load. The root is backdated here to cover boot work before the label is known. */
  startedAt: number;
  /** The page the trace runs in, the browser's by default. */
  page?: TracedPage | undefined;
  /** The wall clock the spans are placed on. The page's own by default. */
  timers?: Pick<Timers, 'now'>;
  /** The monotonic clock durations are measured on, in milliseconds. Defaults to the page's own. */
  now?: () => number;
  /** Draws a number in [0, 1) that decides whether the load gets child spans. The page's own by default. */
  random?: () => number;
};

type EnterPhaseParams = {
  key: ChainRole;
  state: ChainState;
  phase: Phase;
};

/** Share of loads that get child spans. The root always carries every measurement, so nothing is lost. */
const DEFAULT_SAMPLE_RATE = 0.2;

/**
 * Opens the load's trace and returns its reporter. Safe when metrics are off: every span handle is inert. Throws only
 * as `page.lifecycle.addEventListener` does.
 */
export function startResolutionTrace({
  domain,
  network,
  backend,
  attempt,
  startedAt,
  page = getBrowserPage(),
  timers = realTimers,
  now: readClock = readPageClock,
  random = () => Math.random(),
}: ResolutionTraceParams) {
  // Monotonic deltas from one wall-clock start, so a system clock that steps mid-load cannot reorder the tree.
  const epochStart = timers.now() - (readClock() - startedAt);

  const sampled = isSampled(random);

  const root = m.open('resolution', {
    root: true,
    startTime: epochStart,
    attributes: {
      domain,
      network,
      backend,
      sampled_children: sampled,
      journey_id: attempt.journeyId,
      attempt_number: attempt.attemptNumber,
      entry: attempt.entry,
    },
  });

  const chains = new Map<ChainRole, ChainState>();
  // Taken while the loading screen was still being driven.
  let lastBarPercent: number | null = null;
  let bytesTotal = 0;
  let peakBytesPerSecond = 0;
  let lastBytes = 0;
  let lastBytesAt = startedAt;
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

  function readEpochTime(): number {
    return epochStart + (readClock() - startedAt);
  }

  function readSinceStart(): number {
    return readClock() - startedAt;
  }

  function getChainState(key: ChainRole): ChainState {
    let state = chains.get(key);
    if (state === undefined) {
      state = createChainState();
      // Opens when the chain is first heard from, or Bulletin, created only for content, would look idle, not absent.
      state.span = sampled ? root.child(`chain.${getChainTelemetryName(key)}`, { startTime: readEpochTime() }) : null;
      chains.set(key, state);
    }
    return state;
  }

  function sampleBar(): void {
    const seen = page.readProgress();
    if (seen > 0) {
      lastBarPercent = seen;
    }
  }

  function enterPhase({ key, state, phase }: EnterPhaseParams): void {
    if (state.phase === phase) {
      return;
    }
    state.phaseSpan?.end(readEpochTime());
    state.phase = phase;
    // Named in full, since `child` does not inherit the parent's name and every chain would report `dotli.ready`.
    state.phaseSpan =
      state.span === null
        ? null
        : state.span.child(`chain.${getChainTelemetryName(key)}.${phase}`, { startTime: readEpochTime() });
  }

  function recordChainSync(event: ChainSyncEvent): void {
    if (finished) {
      return;
    }
    const state = getChainState(event.chain);
    const phase = PHASE_BY_MILESTONE[event.kind];
    // A stall interrupts a phase rather than being one, so it is an attribute, not a span.
    if (phase !== undefined && phase !== 'stalled') {
      enterPhase({ key: event.chain, state, phase });
    }
    switch (event.kind) {
      case 'peers':
        if (typeof event.peers === 'number') {
          state.peersMax = Math.max(state.peersMax, event.peers);
        }
        break;
      case 'firstPeer':
        state.firstPeerMs ??= readSinceStart();
        break;
      case 'bootstrapComplete':
        state.readyMs ??= readSinceStart();
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
  }

  function recordChainDetail(event: ChainDetail): void {
    if (finished) {
      return;
    }
    const state = getChainState(event.chain);
    if (event.dbCache !== undefined) {
      // First answer wins: the second Bulletin connection always misses.
      state.dbCache ??= event.dbCache;
    }
    if (event.peers !== undefined) {
      state.peers = event.peers;
    }
  }

  function recordBytes(received: number): void {
    if (finished || !Number.isFinite(received) || received < lastBytes) {
      return;
    }
    bytesTotal = received;
    sampleBar();
    const now = readClock();
    const elapsed = now - lastBytesAt;
    // The seed reading is page start with nothing downloaded, so the first report already has a partner.
    if (elapsed > 0) {
      const rate = ((received - lastBytes) / elapsed) * 1000;
      peakBytesPerSecond = Math.max(peakBytesPerSecond, rate);
    }
    lastBytes = received;
    lastBytesAt = now;
  }

  function recordContent(fetched: number, total: number | null): void {
    if (finished) {
      return;
    }
    sampleBar();
    contentSpan ??= sampled ? root.child('content_fetch', { startTime: readEpochTime() }) : null;
    contentBytes = fetched;
    contentTotal = total;
  }

  function recordNameResolved(resolved: string | null): void {
    if (finished) {
      return;
    }
    cid = resolved;
    nameResolvedMs ??= readSinceStart();
    nameSpan?.setAttributes({
      cid: resolved ?? 'none',
      duration_ms: nameResolvedMs,
    });
    nameSpan?.end(readEpochTime());
    nameSpan = null;
  }

  function recordCidCache(result: CidCacheResult): void {
    cidCacheResult = result;
  }

  function recordStep(name: string): void {
    loadingPhase = name;
  }

  function markHandedOff(): void {
    handoffMs ??= readSinceStart();
  }

  function markWarningShown(): void {
    warned = true;
  }

  function finish(outcome: ResolutionOutcome, details?: FinishDetails): void {
    if (finished) {
      return;
    }
    finished = true;
    dispose();
    const endedAt = readEpochTime();
    const totalMs = readSinceStart();

    nameSpan?.end(endedAt);
    for (const [key, state] of chains) {
      state.phaseSpan?.end(endedAt);
      state.span?.setAttributes(getChainAttributes(key, state));
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
      bar_at_render: lastBarPercent ?? page.readProgress(),
      tab_visible: page.isVisible(),
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
      ...getChainSummary(chains),
    });
    root.end(endedAt);
  }

  // Otherwise a tab closed mid-resolution never sends its root span. A browser reload, a typed URL and a closed tab
  // all read "unload" here, and the next attempt's `entry` tells a reload apart.
  function abandonOnPageHide(event: PageTransitionEvent): void {
    if (finished) {
      return;
    }
    root.setAttributes({ exit: event.persisted ? 'bfcache' : (page.peekContinuation() ?? 'unload') });
    finish('abandoned');
  }

  function dispose(): void {
    page.lifecycle.removeEventListener('pagehide', abandonOnPageHide);
  }

  page.lifecycle.addEventListener('pagehide', abandonOnPageHide);

  return {
    /** Records a chain's sync milestone. Ignored once the trace finished. Never throws. */
    recordChainSync,
    /** Records a telemetry-only fact about one chain. Ignored once the trace finished. Never throws. */
    recordChainDetail,
    /**
     * Records the cumulative bytes the light client has pulled off the network. Ignored once the trace finished, or
     * when the count is not finite or went back. Never throws.
     */
    recordBytes,
    /** Records the content fetch's progress. Ignored once the trace finished. Never throws. */
    recordContent,
    /** Records the name's CID, null for none. Ignored once the trace finished. Never throws. */
    recordNameResolved,
    /** Records what the CID cache lookup found. Never throws. */
    recordCidCache,
    /** Records the load's step, reported as `loading_phase` wherever the load ends. Never throws. */
    recordStep,
    /** Records that the sandbox iframe is mounted and the download is its to run. Never throws. */
    markHandedOff,
    /** Records that the visitor was shown a slow-load warning. Never throws. */
    markWarningShown,
    /** The trace's root, for linking this load's errors to it. */
    span: root,
    /**
     * Ends the trace with `outcome` and stops listening for the visitor leaving. Idempotent: the first outcome wins.
     * Throws only as `page.lifecycle.removeEventListener` does.
     */
    finish,
    /**
     * Stops listening for the visitor leaving, so a trace not yet finished is no longer ended as abandoned. Idempotent.
     * Throws only as `page.lifecycle.removeEventListener` does.
     */
    dispose,
  };
}

/** From the loading store, not the bar's markup, so a load whose loading island never mounted still reports it. */
function getBrowserPage(): TracedPage {
  return {
    lifecycle: window,
    isVisible: () => document.visibilityState === 'visible',
    readProgress: () => loadingState.get().progress,
    peekContinuation: continuation.peek,
  };
}

function readSampleRate(): number {
  const raw = Number(import.meta.env.VITE_RESOLUTION_SAMPLE_RATE ?? '');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_SAMPLE_RATE;
}

/** Decided at the start, since Sentry fixes a trace's sampling when its root opens. */
function isSampled(random: () => number): boolean {
  return random() < readSampleRate();
}

function createChainState(): ChainState {
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

function getChainAttributes(key: ChainRole, state: ChainState): Record<string, SpanValue> {
  const attributes: Record<string, SpanValue> = {
    chain: getChainTelemetryName(key),
    peers_max: state.peersMax,
    stall_count: state.stallCount,
  };
  if (state.dbCache !== null) {
    attributes['db_cache'] = state.dbCache;
  }
  if (state.firstPeerMs !== null) {
    attributes['time_to_first_peer_ms'] = state.firstPeerMs;
  }
  if (state.readyMs !== null) {
    attributes['time_to_ready_ms'] = state.readyMs;
  }
  if (state.stallReasons.size > 0) {
    attributes['stall_reasons'] = [...state.stallReasons].join(',');
  }
  if (state.warpTarget !== null) {
    attributes['warp_target'] = state.warpTarget;
    if (state.warpAt !== null) {
      attributes['warp_at'] = state.warpAt;
    }
    if (state.warpFrom !== null && state.warpAt !== null) {
      attributes['warp_from'] = state.warpFrom;
      attributes['warp_blocks'] = state.warpAt - state.warpFrom;
    }
  }
  const peers = state.peers ?? [];
  const heights = peers.map(peer => peer.bestNumber).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  if (median !== undefined) {
    attributes['peers_count'] = peers.length;
    attributes['peers_authority'] = peers.filter(peer => peer.roles === 'AUTHORITY').length;
    attributes['peers_best_median'] = median;
    // Public identities of infrastructure nodes from the chain specs, never the visitor's.
    attributes['peers_ids'] = peers
      .map(peer => peer.peerId)
      .join(',')
      .slice(0, 1000);
    if (state.warpTarget !== null) {
      // A lag near zero says the network was fine and the time went elsewhere.
      attributes['peer_best_lag'] = state.warpTarget - median;
    }
  }
  return attributes;
}

/** Flattened for the root, so an unsampled load still has them. */
function getChainSummary(chains: ReadonlyMap<ChainRole, ChainState>): Record<string, SpanValue> {
  const out: Record<string, SpanValue> = {};
  for (const [role, state] of chains) {
    const key = getChainTelemetryName(role);
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
