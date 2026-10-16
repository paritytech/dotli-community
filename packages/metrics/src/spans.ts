// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Metric names, without the `dotli.` prefix the metrics API adds.

/** From client creation to first finalized block. */
export const SMOLDOT_FINALIZED_BLOCK = 'smoldot.finalized_block';

/** Create, relay, asset hub and first finalized block together. */
export const SMOLDOT_PRESYNC = 'smoldot.presync';

/**
 * Liveness heartbeat, the constant `1` once per 60s per light client.
 * Read it with `count_unique(trace)`. Summing counts heartbeats, which scale with the bucket size.
 * A heartbeat because a client dies with its tab or worker and never reports a destroy.
 */
export const SMOLDOT_ACTIVE = 'smoldot.active';

/** Mode detection plus engine start. */
export const PROTOCOL_INIT = 'protocol.init';

/** From SharedWorker creation to its ready signal. */
export const PROTOCOL_SW_READY = 'protocol.sw_ready';

export const PROTOCOL_MODE = 'protocol.mode';

export const RESOLVE_STORAGE_READ = 'resolve.storage_read';

/**
 * Read and validate one manifest text record. Tag `kind` (`root, app, widget, worker`) and `outcome`
 * (`ok, empty, invalid, error`) so "no manifest yet" is told apart from "malformed".
 */
export const RESOLVE_MANIFEST_READ = 'resolve.manifest_read';

export const CACHE_HIT = 'cache.hit';

export const CACHE_MISS = 'cache.miss';

export const CONTENT_GATEWAY = 'content.gateway';

/** Whichever fetch method wins. */
export const CONTENT_FETCH = 'content.fetch';

/** From CID cache hit to content rendered. */
export const E2E_FAST = 'e2e.fast_path';

/** CID cache miss, then resolve, fetch and render. */
export const E2E_SLOW = 'e2e.slow_path';

/** One `bitswap_v1_get` round trip. Tag `outcome` with `ok, retry, backoff, not-found, invalid-cid, timeout`. */
export const CONTENT_BITSWAP_RPC = 'content.bitswap_rpc';

/** Blocks per content fetch, 1 for raw and N for dag-pb directories. */
export const CONTENT_BITSWAP_BLOCKS = 'content.bitswap_blocks';

/** Bytes. */
export const CONTENT_SIZE = 'content.size';

export const CACHE_READ_LATENCY = 'cache.read_latency';

export const CACHE_WRITE_LATENCY = 'cache.write_latency';

/** The fresh CID matches the served one. */
export const CACHE_REVALIDATE_MATCH = 'cache.revalidate_match';

/** The fresh CID differs and the user gets a reload notice. */
export const CACHE_REVALIDATE_UPDATE = 'cache.revalidate_update';

/** The network pointer was cleared, so the cache is evicted and the page reloaded. */
export const CACHE_REVALIDATE_CLEARED = 'cache.revalidate_cleared';

/** The resolver threw. The cache entry is left intact. */
export const CACHE_REVALIDATE_ERROR = 'cache.revalidate_error';

export const CACHE_REVALIDATE_LATENCY = 'cache.revalidate_latency';

/** Whole sandbox app load. */
export const APP_TOTAL = 'app.total';

export const APP_SW_REGISTER = 'app.sw_register';

/** Protocol iframe creation plus the wait for ready. */
export const PROTOCOL_IFRAME_READY = 'protocol.iframe_ready';

export const PROTOCOL_REQUEST = 'protocol.request';

/**
 * One request as the SharedWorker served it, tagged with the asking tab's `resolution_id`.
 * Apart from `PROTOCOL_REQUEST` because it excludes the postMessage hops.
 */
export const PROTOCOL_WORKER_REQUEST = 'protocol.worker_request';

/** Dynamic import of the container chunk. */
export const BRIDGE_CHUNK_LOAD = 'bridge.chunk_load';

export const BRIDGE_SETUP = 'bridge.setup';

/** Measured with a PerformanceObserver. */
export const WASM_LOAD = 'wasm.load';

/**
 * Shared-storage request rejected before touching `localStorage`. Tagged `store` and `reason`,
 * because the error envelope the listener answers with is easy to miss.
 */
export const SHARED_STORAGE_REJECTED = 'shared_storage.rejected';

/**
 * One read of the login session shared across subdomains. Tagged `outcome` (hit, miss or error) and, on error,
 * `reason`, because a failed read shows the login screen exactly like a missing session.
 */
export const SHARED_SESSION_READ = 'shared_session.read';

/** Local wallet boot, activation and identity steps. Tagged `outcome` and, on failure, `reason`. */
export const WALLET_LOCAL_ACTIVATE = 'wallet.local_activate';
