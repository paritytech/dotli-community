// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One page load, recorded as one Sentry trace.
//
// Everything a resolution does happens somewhere else: the chains run in the
// protocol iframe, the archive unpacks in the sandbox, and both report back
// over postMessage. This module is the one place that collects those reports
// into a single tree, so `resolution_id:<uuid>` in Sentry returns the whole
// load rather than three unrelated fragments.
//
// The tree is built live rather than assembled at the end, because a load that
// never finishes is the one worth looking at, and a tree assembled at the end
// is exactly the tree such a load never produces.

import type { ChainKey } from "@dotli/resolver/chain-sync";
import type { ChainPeer } from "@dotli/resolver/chain-sync";
import { m, type SpanHandle, type SpanValue } from "@dotli/metrics/metrics";

/** How a resolution ended. `abandoned` means the tab left before it did. */
export type ResolutionOutcome = "rendered" | "error" | "abandoned";

export type CacheResult = "hit" | "miss";

/** The phases a chain moves through, as the light client reports them. */
type Phase = "connecting" | "syncing" | "ready";

const PHASE_BY_MILESTONE: Partial<Record<string, Phase>> = {
  connecting: "connecting",
  warpSyncProgress: "syncing",
  warpSyncFinished: "ready",
  bootstrapComplete: "ready",
};

/**
 * Fraction of successful resolutions that get the full per-chain span tree.
 *
 * The root span is always emitted and always carries every measurement, so
 * nothing is lost at any rate: sampling decides whether the ~16 child spans
 * come with it. Successes are near-identical to one another and cheap to
 * characterise from the root alone, so a fifth of them is plenty to watch a
 * distribution move. Failures ignore this entirely. See `sampleFor`.
 */
const DEFAULT_SAMPLE_RATE = 0.2;

function sampleRate(): number {
  const raw = Number(
    (import.meta.env.VITE_RESOLUTION_SAMPLE_RATE as string | undefined) ?? "",
  );
  return Number.isFinite(raw) && raw >= 0 && raw <= 1
    ? raw
    : DEFAULT_SAMPLE_RATE;
}

/**
 * Whether this load records child spans.
 *
 * Decided at the start, because Sentry fixes a trace's sampling when its root
 * opens and a failure discovered 30 seconds later cannot retroactively add
 * children. A load that has already failed once this session is always
 * sampled, which is the closest thing to "keep the interesting ones" that the
 * up-front decision allows.
 */
function sampleFor(retryAfterFailure: boolean): boolean {
  return retryAfterFailure || Math.random() < sampleRate();
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
  syncKind: string;
  peers?: number;
  reason?: string;
  at?: number;
  target?: number;
}

export interface ResolutionTrace {
  /** A milestone from the light client. */
  chainSync: (event: ChainSyncFacts) => void;
  /** A telemetry-only fact about one chain. */
  chainDetail: (event: {
    chain: ChainKey;
    dbCache?: CacheResult;
    peers?: ChainPeer[];
  }) => void;
  /** Cumulative bytes the light client has pulled off the network. */
  bytes: (received: number) => void;
  /** Archive download progress, from the sandbox's own reports. */
  content: (fetched: number, total: number | null) => void;
  /** The name resolved, or did not. */
  nameResolved: (cid: string | null) => void;
  cidCache: (result: CacheResult) => void;
  /** Close the trace. Idempotent: the first outcome wins. */
  finish: (outcome: ResolutionOutcome, failureReason?: string) => void;
}

export interface ResolutionTraceOptions {
  domain: string;
  network: string;
  backend: string;
  providerVersion?: string;
  /** Forces sampling: a retry means the previous attempt already failed. */
  retryAfterFailure?: boolean;
}

/**
 * Begin tracing this page load.
 *
 * Safe to call when metrics are stripped: every span handle is inert and the
 * bookkeeping below costs a few numbers.
 */
export function startResolutionTrace(
  opts: ResolutionTraceOptions,
): ResolutionTrace {
  // Sentry wants wall-clock, the rest of the host measures with the monotonic
  // clock. Both are captured once here so every span time is the monotonic
  // delta projected onto the wall clock, and a system clock that steps mid-load
  // cannot reorder the tree.
  const epochStart = Date.now();
  const perfStart = performance.now();
  const at = (): number => epochStart + (performance.now() - perfStart);
  const sinceStart = (): number => performance.now() - perfStart;

  const sampled = sampleFor(opts.retryAfterFailure === true);

  const root = m.open("resolution", {
    root: true,
    startTime: epochStart,
    attributes: {
      domain: opts.domain,
      network: opts.network,
      backend: opts.backend,
      sampled_children: sampled,
      ...(opts.providerVersion !== undefined
        ? { provider_version: opts.providerVersion }
        : {}),
    },
  });

  const chains = new Map<ChainKey, ChainState>();
  const chainOf = (key: ChainKey): ChainState => {
    let state = chains.get(key);
    if (state === undefined) {
      state = newChainState();
      // The chain span opens when the chain is first heard from, not at boot:
      // Bulletin is created only once the content phase starts, and a span
      // opened earlier would claim it was idle rather than absent.
      state.span = sampled
        ? root.child(`chain.${key}`, { startTime: at() })
        : null;
      chains.set(key, state);
    }
    return state;
  };

  // Last bar reading taken while the loading screen was still being driven.
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
  let cidCacheResult: CacheResult | null = null;
  let nameResolvedMs: number | null = null;
  let nameSpan: SpanHandle | null = sampled
    ? root.child("name_resolution", { startTime: epochStart })
    : null;
  let contentSpan: SpanHandle | null = null;
  let finished = false;

  const enterPhase = (key: ChainKey, state: ChainState, phase: Phase): void => {
    if (state.phase === phase) {
      return;
    }
    state.phaseSpan?.end(at());
    state.phase = phase;
    // Named in full rather than just the phase: `child` does not inherit the
    // parent's name, so four chains would otherwise all report `dotli.ready`
    // and only be separable by walking to their parent.
    state.phaseSpan =
      state.span === null
        ? null
        : state.span.child(`chain.${key}.${phase}`, { startTime: at() });
  };

  const trace: ResolutionTrace = {
    chainSync: (event) => {
      if (finished) {
        return;
      }
      const state = chainOf(event.chain);
      const phase = PHASE_BY_MILESTONE[event.syncKind];
      if (phase !== undefined) {
        enterPhase(event.chain, state, phase);
      }
      switch (event.syncKind) {
        case "peers":
          if (typeof event.peers === "number") {
            state.peersMax = Math.max(state.peersMax, event.peers);
          }
          break;
        case "firstPeer":
          state.firstPeerMs ??= sinceStart();
          break;
        case "bootstrapComplete":
          state.readyMs ??= sinceStart();
          break;
        case "stalled":
          state.stallCount += 1;
          if (event.reason !== undefined) {
            state.stallReasons.add(event.reason);
          }
          break;
        case "warpSyncProgress":
          if (typeof event.at === "number") {
            state.warpFrom ??= event.at;
            state.warpAt = event.at;
          }
          if (typeof event.target === "number") {
            state.warpTarget = event.target;
          }
          break;
        default:
          break;
      }
    },

    chainDetail: (event) => {
      if (finished) {
        return;
      }
      const state = chainOf(event.chain);
      if (event.dbCache !== undefined) {
        state.dbCache = event.dbCache;
      }
      if (event.peers !== undefined) {
        state.peers = event.peers;
      }
    },

    bytes: (received) => {
      if (finished || !Number.isFinite(received) || received < lastBytes) {
        return;
      }
      bytesTotal = received;
      sampleBar();
      const now = performance.now();
      const elapsed = now - lastBytesAt;
      // A rate needs two readings. The seed reading is the page's own start
      // with nothing downloaded, so the first report already has a partner.
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
      contentSpan ??= sampled
        ? root.child("content_fetch", { startTime: at() })
        : null;
      contentBytes = fetched;
      contentTotal = total;
    },

    nameResolved: (resolved) => {
      if (finished) {
        return;
      }
      cid = resolved;
      nameResolvedMs ??= sinceStart();
      nameSpan?.setAttributes({
        cid: resolved ?? "none",
        duration_ms: nameResolvedMs,
      });
      nameSpan?.end(at());
      nameSpan = null;
    },

    cidCache: (result) => {
      cidCacheResult = result;
    },

    finish: (outcome, failureReason) => {
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
        tab_visible: document.visibilityState === "visible",
        ...(cid !== null ? { cid } : {}),
        ...(cidCacheResult !== null ? { cid_cache: cidCacheResult } : {}),
        ...(nameResolvedMs !== null
          ? { name_resolution_ms: nameResolvedMs }
          : {}),
        ...(failureReason !== undefined
          ? { failure_reason: failureReason.slice(0, 200) }
          : {}),
        // Flattened onto the root as well as the chain spans, so an unsampled
        // load still answers "which chain was slow" without any children.
        ...chainSummary(chains),
      });
      root.end(endedAt);
    },
  };

  // A load that never finishes is the one worth having. Without this the tab
  // closes mid-resolution and the root span is never sent at all, so the
  // failures are exactly the traces Sentry never sees.
  window.addEventListener("pagehide", () => {
    trace.finish("abandoned");
  });

  return trace;
}

/** The loading bar's own percentage, which is what the visitor was shown. */
function readBarPercent(): number {
  const fill = document.querySelector<HTMLElement>(".loading-progress-fill");
  const width = fill?.style.width ?? "";
  const parsed = Number.parseFloat(width);
  return Number.isFinite(parsed) ? parsed : 0;
}

function chainAttributes(
  key: ChainKey,
  state: ChainState,
): Record<string, SpanValue> {
  const attrs: Record<string, SpanValue> = {
    chain: key,
    peers_max: state.peersMax,
    stall_count: state.stallCount,
  };
  if (state.dbCache !== null) {
    attrs.db_cache = state.dbCache;
  }
  if (state.firstPeerMs !== null) {
    attrs.time_to_first_peer_ms = state.firstPeerMs;
  }
  if (state.readyMs !== null) {
    attrs.time_to_ready_ms = state.readyMs;
  }
  if (state.stallReasons.size > 0) {
    attrs.stall_reasons = [...state.stallReasons].join(",");
  }
  if (state.warpTarget !== null) {
    attrs.warp_target = state.warpTarget;
    if (state.warpAt !== null) {
      attrs.warp_at = state.warpAt;
    }
    if (state.warpFrom !== null && state.warpAt !== null) {
      attrs.warp_from = state.warpFrom;
      attrs.warp_blocks = state.warpAt - state.warpFrom;
    }
  }
  const peers = state.peers;
  if (peers !== null && peers.length > 0) {
    const heights = peers.map((peer) => peer.bestNumber).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    attrs.peers_count = peers.length;
    attrs.peers_authority = peers.filter(
      (peer) => peer.roles === "AUTHORITY",
    ).length;
    attrs.peers_best_median = median;
    // Peer ids are the public libp2p identities of infrastructure nodes,
    // published in chain specs. They name a remote server, never the visitor.
    attrs.peers_ids = peers
      .map((peer) => peer.peerId)
      .join(",")
      .slice(0, 1000);
    if (state.warpTarget !== null) {
      // How far behind the chain's own peers were. A lag near zero says the
      // network was fine and the time went somewhere else.
      attrs.peer_best_lag = state.warpTarget - median;
    }
  }
  return attrs;
}

/** Per-chain timings flattened for the root, so an unsampled load still has them. */
function chainSummary(
  chains: ReadonlyMap<ChainKey, ChainState>,
): Record<string, SpanValue> {
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
