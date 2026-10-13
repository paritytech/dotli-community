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

/** Count. The protocol frame could not read its session tuning, so the light client starts with defaults. */
export const PROTOCOL_SESSION_TUNING = 'protocol.session_tuning';

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

/** Count. A full reset's wipe of the sandbox origin, with the stores it could not wipe as the reason. */
export const APP_ORIGIN_PURGE = 'app.origin_purge';

/**
 * A sandbox run whose load rejected or whose failure could not be shown, both outside the load's own handling. Tagged
 * `outcome` and `reason` (`load_rejected` or `show_threw`).
 */
export const APP_RUN = 'app.run';

/** Protocol iframe creation plus the wait for ready. */
export const PROTOCOL_IFRAME_READY = 'protocol.iframe_ready';

/**
 * A protocol status listener that threw. Tagged `outcome` (error) and `reason` (the error's name), as the listener
 * then missed that change.
 */
export const PROTOCOL_STATUS_LISTENER = 'protocol.status_listener';

/**
 * A chain sync or chain detail listener that threw. Tagged `outcome` (error) and `reason` (the error's name), as the
 * listener then missed that milestone.
 */
export const CHAIN_SYNC_LISTENER = 'chain_sync.listener';

/**
 * A debug bus watcher, or a panel during its boot replay, that threw. Tagged `outcome` (error) and `reason` (the
 * error's name), as that receiver then missed the event.
 */
export const DEBUG_BUS_LISTENER = 'debug_bus.listener';

export const PROTOCOL_REQUEST = 'protocol.request';

/**
 * One request as the SharedWorker served it, tagged with the asking tab's `resolution_id`.
 * Apart from `PROTOCOL_REQUEST` because it excludes the postMessage hops.
 */
export const PROTOCOL_WORKER_REQUEST = 'protocol.worker_request';

/**
 * A sandbox message handler on the host that threw. Tagged `outcome` (error) and `reason` (the error's name), as the
 * sandbox then gets no answer.
 */
export const SANDBOX_HANDLER = 'sandbox.handler';

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

/**
 * One read of the mode settings shared across subdomains. Tagged `outcome` and, on error, `reason`, because a failed
 * read falls back to this origin's settings without a sign.
 */
export const SHARED_MODE_READ = 'shared_mode.read';

/** Local wallet boot, activation and identity steps. Tagged `outcome` and, on failure, `reason`. */
export const WALLET_LOCAL_ACTIVATE = 'wallet.local_activate';

/**
 * One redial of the page's wallet core after the core was taken out of service. Tagged `outcome` (ok, error or aborted,
 * when a product change dropped it) and `reason`, what took the core out, as a failed one leaves the page without a
 * core.
 */
export const WALLET_CORE_REDIAL = 'wallet.core_redial';

/**
 * A render the product frame started on its own: on a replacement core, after a device permission change or at a
 * reloaded sandbox's ask. Tagged `outcome` (ok, error, or aborted when a newer render or a core loss took over) and
 * `reason` (which of those, or `core_deaths` once the frame stopped rendering on cores that kept dying), as no caller
 * is there to report it.
 */
export const PRODUCT_RERENDER = 'product.rerender';

/**
 * A product frame status listener that threw. Tagged `outcome` (error) and `reason` (the error's name), as the listener
 * then missed that change.
 */
export const PRODUCT_STATUS_LISTENER = 'product.status_listener';

/** A topbar logout of a paired session. Tagged `outcome` and, on error, `reason`, as a failed one leaves the user in. */
export const WALLET_LOGOUT = 'wallet.logout';

/** One read of the loaded product's permissions. Tagged `outcome` and, on error, `reason`, as a failed one leaves the menu without statuses. */
export const PERMISSIONS_READ = 'permissions.read';

/**
 * A permission change from the menu. Tagged `outcome` and, on error, `reason` (the intent that failed), as a failed one
 * leaves the permission as it was.
 */
export const PERMISSIONS_CHANGE = 'permissions.change';

/**
 * One Share diagnostic click in the debug panel. Tagged `outcome` and, on error, `reason`, as a failed one opens no
 * issue.
 */
export const DIAGNOSTICS_SHARE = 'diagnostics.share';

/**
 * One drawing of the sign-in QR code. Tagged `outcome` and, on error, `reason`, as a failed one leaves the sign-in on
 * its spinner with nothing to scan.
 */
export const AUTH_QR_RENDER = 'auth.qr_render';

/**
 * One Save & Apply or Clear all in the settings. Tagged `outcome` and, on error, `reason` (the step that failed:
 * `wipe`, `cid_cache`, `block_cache` or `pending_reset`, or the error's name for a step that threw), as the reload
 * follows either way.
 */
export const SETTINGS_APPLY = 'settings.apply';

/** One part of an origin wipe that failed. Tagged `outcome` (error) and `reason` (indexeddb, cache_storage or service_worker). */
export const ORIGIN_WIPE = 'settings.origin_wipe';

/**
 * A purge request that could not be read on boot. Tagged `outcome` and `reason` (the storage error's name), as the
 * boot then goes ahead without the purge.
 */
export const PENDING_RESET_READ = 'pending_reset.read';

/**
 * A purge request the failure screen could not store before its reload. Tagged `outcome` and `reason`, as the reload
 * then comes up on the chain database it had.
 */
export const PENDING_RESET_SCHEDULE = 'pending_reset.schedule';

/**
 * One failed read, write or clear of the cached account shown before the session is read. Tagged `outcome` (error, or
 * invalid for a cache that does not parse) and `reason` (`read`, `write`, `clear` or `json`), as a failure shows a
 * stale name or none.
 */
export const SHARED_SESSION_UI_CACHE = 'shared_session.ui_cache';

/**
 * One finalized height the diagnostics report asks a chain for. Tagged `outcome` (ok, error or timeout) and, on
 * failure, `reason`, as a failed one prints n/a.
 */
export const DIAGNOSTICS_FINALIZED_BLOCK = 'diagnostics.finalized_block';

/**
 * A failed read or write of the recently visited names in the shared store. Tagged `outcome` and `reason` (`read`,
 * `write` or `migrate`), as the list then lives in this origin only.
 */
export const RECENT_LABELS_UPDATE = 'recent_labels.update';

/**
 * A chunk Vite's preload helper failed to load, mostly a deploy that replaced it. Tagged `outcome` and `reason` (the
 * error's name). The caller of the import reports the failure itself, so this reads as the rate behind those reports.
 */
export const CHUNK_PRELOAD = 'chunk.preload';

/**
 * A clipboard write the debug panel's copy controls could not make, mostly the browser's refusal. Tagged `outcome`
 * (error) and `reason` (the error's name), as the control then shows a cross.
 */
export const DEBUG_PANEL_COPY = 'debug_panel.copy';

/** One start of the debug panel in debug mode. Tagged `outcome` and, on error, `reason`, as a failed one shows no panel. */
export const DEBUG_PANEL_LOAD = 'debug_panel.load';

/** A lazy chunk a caller could not load and went on without. Tagged `outcome` and `reason` (the caller's step). */
export const LAZY_CHUNK_LOAD = 'lazy_chunk.load';

/**
 * A shell state part whose stop threw. Tagged `outcome` (error) and `reason` (the error's name), as that part may keep
 * running after the shell state stopped.
 */
export const SHELL_STATE_STOP = 'shell_state.stop';
