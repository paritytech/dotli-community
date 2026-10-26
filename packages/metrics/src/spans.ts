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

/** Count. An unpin the light client refused while the follow ran, so pins pile up. Tag `outcome` and `reason`. */
export const RESOLVE_UNPIN = 'resolve.unpin';

/** A cache read. Tag `outcome` (`hit, miss`) and `surface` (`cid_cache, block_cache`). */
export const CACHE_READ = 'cache.read';

export const CONTENT_GATEWAY = 'content.gateway';

/** Whichever fetch method wins. */
export const CONTENT_FETCH = 'content.fetch';

/** From CID cache hit to content rendered. */
export const E2E_FAST = 'e2e.fast_path';

/** CID cache miss, then resolve, fetch and render. */
export const E2E_SLOW = 'e2e.slow_path';

/** One `bitswap_v1_get` round trip. Tag `outcome` (`ok, error, aborted`) and, on a failure, `reason` (the error name). */
export const CONTENT_BITSWAP_RPC = 'content.bitswap_rpc';

/** Blocks per content fetch, as a distribution: 1 for raw and N for dag-pb directories. */
export const CONTENT_BITSWAP_BLOCKS = 'content.bitswap_blocks';

/** A bitswap relay step that failed. Tag `outcome` (`error`), `reason` (the error name) and `step` (`verify, cache_read, cache_delete, cache_write`). */
export const CONTENT_BLOCK_RELAY = 'content.block_relay';

/** Bytes. */
export const CONTENT_SIZE = 'content.size';

export const CACHE_READ_LATENCY = 'cache.read_latency';

export const CACHE_WRITE_LATENCY = 'cache.write_latency';

/**
 * A cache's storage step that failed. Counted only on failure, tagged `outcome` (error), `reason` (the error's name),
 * `surface` (`cid_cache, block_cache`) and `step` (`read, write, touch, delete, evict, prune, clear`).
 */
export const CACHE_STORAGE = 'cache.storage';

/**
 * A cached copy checked against the network. Tag `outcome`: `match` (unchanged), `update` (the visitor is offered a
 * reload onto the newer version), `cleared` (evicted, and the page reloads when it showed the copy) or `error` (the
 * check failed and the entry is left as it was).
 */
export const CACHE_REVALIDATE = 'cache.revalidate';

export const CACHE_REVALIDATE_LATENCY = 'cache.revalidate_latency';

/** Whole sandbox app load. */
export const APP_TOTAL = 'app.total';

export const APP_SW_REGISTER = 'app.sw_register';

/** Count. A full reset's wipe of the sandbox origin, with the stores it could not wipe as the reason. */
export const APP_ORIGIN_PURGE = 'app.origin_purge';

/**
 * A sandbox run whose load rejected or whose failure could not be shown, both outside the load's own handling. Tagged
 * `outcome` and `reason` (`load_rejected`, `show_threw` or `fallback_missing`).
 */
export const APP_RUN = 'app.run';

/** Protocol iframe creation plus the wait for ready. */
export const PROTOCOL_IFRAME_READY = 'protocol.iframe_ready';

/**
 * A protocol frame lost after it was ready, so the host rebuilds it. Tagged `outcome` (error) and `reason` (the error's
 * name, `ProtocolPortReleasedError` for a tab the SharedWorker let go of while it was frozen).
 */
export const PROTOCOL_FRAME_LOST = 'protocol.frame_lost';

/**
 * A listener that threw, so it missed that delivery. Tagged `outcome` (error), `reason` (the error's name) and `owner`
 * (whose listeners, such as `chain_pool.status` or `debug_bus.replay`).
 */
export const LISTENER_DELIVERY = 'listener.delivery';

export const PROTOCOL_REQUEST = 'protocol.request';

/**
 * A protocol message dropped on receipt. Tagged `outcome` (refused), `side` (host, frame or worker) and `reason`:
 * `malformed` for bytes that are no message, `invalid` for a message whose values its method refuses, `not_bytes` for
 * data that is not an `ArrayBuffer`, which a host page of an earlier release sends, and `origin` for the first bytes from
 * each page outside the frame's trust boundary.
 */
export const PROTOCOL_WIRE_REFUSED = 'protocol.wire_refused';

/**
 * A protocol message a side could not post, so its peer never hears it. Tagged `outcome` (error), `side` (host, frame or
 * worker) and `reason` (the error's name).
 */
export const PROTOCOL_SERVE_POST = 'protocol.serve_post';

/**
 * A chain message from the protocol frame that the host could not parse, so its connection never hears it. Tagged
 * `outcome` (error) and `reason` (the error's name).
 */
export const PROTOCOL_CHAIN_MESSAGE = 'protocol.chain_message';

/**
 * A feed the protocol frame ended while it stayed up, so the host reopens it after a backoff. Tagged `outcome` (error),
 * `feed` (shared_auth or telemetry) and `reason` (the error's name, `ProtocolFeedEndedError` for an end without one).
 */
export const PROTOCOL_FEED_END = 'protocol.feed_end';

/**
 * The light client's byte meter could not be read on a tick, so the speed readout misses that reading. Counted once per
 * run of failed reads. Tagged `outcome` (error) and `reason` (the error's name).
 */
export const PROTOCOL_NET_BYTES_READ = 'protocol.net_bytes_read';

/**
 * One request as the SharedWorker served it, tagged with the asking tab's `resolution_id`.
 * Apart from `PROTOCOL_REQUEST` because it excludes the postMessage hops.
 */
export const PROTOCOL_WORKER_REQUEST = 'protocol.worker_request';

/**
 * A heartbeat the protocol frame could not send the SharedWorker, so it stops answering the worker's beats and the
 * worker lets go of its port. Tagged `outcome` (error) and `reason` (the error's name).
 */
export const PROTOCOL_WORKER_HEARTBEAT = 'protocol.worker_heartbeat';

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
 * because the failed answer the caller receives is easy to miss.
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
 * One `acquire` the session lease made of the page core. Tagged `outcome` (ok or error) and, on error, `reason`: `boot`
 * for a first boot that failed and `redial` for a replacement that could not boot.
 */
export const WALLET_SESSION_LEASE = 'wallet.session_lease';

/**
 * A render the product frame started on its own: on a replacement core, after a device permission change or at a
 * reloaded sandbox's ask. Tagged `outcome` (ok, error, or aborted when a newer render or a core loss took over) and
 * `reason` (which of those, or `core_deaths` once the frame stopped rendering on cores that kept dying), as no caller
 * is there to report it.
 */
export const PRODUCT_RERENDER = 'product.rerender';

/**
 * A frame on the topbar login's own connection that the login skipped and survived. Tagged `outcome` (error) and
 * `reason` (`undecodable_frame`, a frame that did not decode, counted once per login).
 */
export const WALLET_LOGIN_FRAME = 'wallet.login_frame';

/**
 * A page's sign-out of a paired session. Tagged `outcome` (`ok` once the phone was told) and, on error, `reason`:
 * `read` for a copy that could not be read, `end` for a session that could not be activated or ended on the ending
 * core, so the phone was not told, `drop` for a local-mode sign-out whose paired copy could not be dropped, on a page
 * that pairs in place or on a product whose flag is unreadable, where a copy it could not read counts too, and
 * `no_window` for a local-mode sign-out on a page that pairs in place, which lets the paired copy go without telling
 * the phone. A paired sign-out counts once, and a core or copy that could not let go is reported as an issue only.
 */
export const WALLET_LOGOUT = 'wallet.logout';

/** One read of the loaded product's permissions. Tagged `outcome` and, on error, `reason`, as a failed one leaves the menu without statuses. */
export const PERMISSIONS_READ = 'permissions.read';

/**
 * A permission change, from the panel or a prompt, counted once when it settles. Tagged `outcome` and, on error,
 * `reason` (`write`), as a failed one leaves the permissions it names as they were.
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
 * One settings reset: Save & Apply or Clear all in the settings, a link that changes a saved choice, or the failure
 * screen's backend switch. Tagged `outcome` and, on error, `reason` (the step that failed: `wipe`, `cid_cache`,
 * `block_cache` or `pending_reset`, or the error's name for a step that threw), as the reload follows either way.
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
 * error's name). The caller of the import counts the failure with a breadcrumb, so this reads as the rate behind those.
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

/** One flush of buffered telemetry before a context closes. Counted only when the flush threw, tagged `outcome` and `reason` (the error's name). */
export const TELEMETRY_FLUSH = 'telemetry.flush';

/**
 * The at-rest key of the core's secret slots. Tagged `outcome` (error) and `reason`: `ephemeral_key` when IndexedDB
 * cannot keep it, so this session's secrets will not decrypt after a reload, or `undecryptable` for a slot dropped
 * because it no longer decrypts.
 */
export const CORE_STORAGE_SECRET = 'core_storage.secret';

/**
 * A read of a product's storage for its subscription that failed. Tagged `outcome` (error) and `reason` (the error's
 * name), as the product then hears only a read failure.
 */
export const PRODUCT_STORAGE_WATCH = 'product_storage.watch';

/**
 * One write of a mode setting shared across subdomains. Tagged `outcome` and, on error, `reason`, as a failed one leaves
 * the other subdomains on the old setting.
 */
export const SHARED_MODE_WRITE = 'shared_mode.write';

/**
 * One preimage lookup a product asked for. Tagged `outcome` and, on error, `reason`: `fetch` once per lookup whose
 * backend keeps failing while the poll retries, or `mismatch` for bytes that do not hash to the key.
 */
export const PREIMAGE_LOOKUP = 'preimage.lookup';

/**
 * A new lease on a host chain after its transport halted. Tagged `outcome` and, on error, `reason`: `no_transport` when
 * the backend no longer serves the chain, `halted` when the new lease halted at once, or the error's name.
 */
export const TRUAPI_CHAIN_REOPEN = 'truapi_chain.reopen';

/**
 * Count. A phone-bound request a waiting step followed to its end. Tagged `outcome` (`ok, refused, aborted, error,
 * gone, undecodable, unmatchable`) and `reason` (the method). A claim's end carries `background`, and a claim whose
 * answer did not decode ends as `undecodable`. A request that did not decode and a review that matched no request are
 * counted on their own, without `background`.
 */
export const PHONE_REQUEST = 'signing.phone_request';

/**
 * A view an answered dialog was to hand its place to that could not be built, so the dialog closed instead. Tagged
 * `outcome` (error) and `reason` (the error's name).
 */
export const MODAL_HANDOFF = 'modal.handoff';

/**
 * Count. What the signed-in flag did to a stored sign-in as a reader went over it. Tagged `outcome`: `dropped` once for
 * each pass of the restore rule that dropped a stored session because the flag was gone, `unreadable` once per page
 * whose flag could not be read so session restore kept what it found, never for a preview its preview host frames,
 * whose flag reads unknown by design, and `error` for a saved session the store would not clear. Tagged `reason`, the
 * reader: `load` for a page's load, `visible` for an open page becoming visible, `window` for the sign-in or sign-out
 * window over the main store.
 */
export const SESSION_PRESENCE = 'session.presence';

/**
 * Count. What an open page did as it became visible and found the signed-in flag changed. Tagged `outcome`:
 * `signed_out` for a page it signed out, `switched` for a page it reloads onto a local wallet replaced elsewhere, and
 * `error` for a sign-out that failed after its retries. Tagged `reason` (`visible`).
 */
export const SESSION_PRESENCE_WATCH = 'session.presence_watch';

/**
 * Count. A write of the signed-in flag that failed, so other subdomains read the old flag. Tagged `outcome` (`error`)
 * and `reason`, the write (`set`, `clear`, or `renew` for a renew of a flag that is still set).
 */
export const SESSION_FLAG_WRITE = 'session.flag_write';

/**
 * Count. A page's ask to sign in through the sign-in window. Tagged `outcome`: `opened` for a window it opened,
 * `blocked` for one the browser refused, and `busy` for an ask while the sign-out window was still open, which opened
 * no window. Tagged `reason`, the intent (`signin, phrase, resume`).
 */
export const SESSION_WINDOW_SIGNIN = 'session_window.signin';

/**
 * Count. How a sign-in round through the window ended. Tagged `outcome` and `reason`, what ended it: `signed_in` with
 * `window` for the window's result, or with `store` for a page that heard the window store the sign-in before its
 * result came, `refused` with `window`, `cancelled` with `closed` for a window found closed when the page came back,
 * `page` for the page's own Cancel or a window it opened in place of the round's, or `signed_out` for a sign-out that
 * ended it.
 */
export const SESSION_WINDOW_ROUND = 'session_window.round';

/**
 * Count. A sign-in window's result the page could not write into its copy. Tagged `outcome` (`error`) and `reason`,
 * the round's intent (`signin, phrase, resume`).
 */
export const SESSION_WINDOW_APPLY = 'session_window.apply';

/**
 * Count. A step of the sign-in window's own flow that failed, so the window reported it and showed a failure where the
 * view has room. Tagged `outcome` (`error`) and `reason`, the step: `decide`, `continue`, `another`, `phrase`, `back`,
 * `pairing` and `finish`.
 */
export const SESSION_WINDOW_FLOW = 'session_window.flow';

/**
 * Count. A page's opening of the sign-out window. Tagged `outcome` (`opened, blocked`) and `reason`, whether the page
 * told the phone itself (`notified, unnotified`).
 */
export const SESSION_WINDOW_SIGNOUT = 'session_window.signout';

/**
 * Count. How the sign-out window's own sign-out ended. Tagged `outcome`: `told_phone` for a paired session it ended on
 * its own core, `cleared` for a store it cleared without telling the phone, `nothing` for a store that held nothing,
 * `kept` for a signed-in flag still set or unreadable, or set again by a sign-in elsewhere before the window cleared,
 * so it left the store as it found it, and `error` for a step that failed while it still cleared what it could, or a
 * boot that failed before it could sign out, which its own issue tells apart. Tagged `reason`, whether the page told
 * the phone itself (`notified, unnotified`).
 */
export const SESSION_WINDOW_SIGNOUT_RESULT = 'session_window.signout_result';

/**
 * Count. A sign-in window that refused its opener, since a page outside the opener rule tried to sign in through it.
 * Tagged `outcome` (`refused`) and `reason`, the rule's verdict: `app` for a product origin, `foreign` for another
 * domain, `insecure` for a wrong scheme, `port` for a wrong port, `localhost` for a local opener of a deployed window
 * and `malformed` for an origin that is not a bare one.
 */
export const SESSION_WINDOW_REFUSED = 'session_window.refused';
