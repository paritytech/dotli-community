// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Metric names, without the `dotli.` prefix the metrics API adds.

export const spans = {
  /** From client creation to first finalized block. */
  SMOLDOT_FINALIZED_BLOCK: 'smoldot.finalized_block',

  /** Create, relay, asset hub and first finalized block together. */
  SMOLDOT_PRESYNC: 'smoldot.presync',

  /**
   * Liveness heartbeat, the constant `1` once per 60s per light client.
   * Read it with `count_unique(trace)`. Summing counts heartbeats, which scale with the bucket size.
   * A heartbeat because a client dies with its tab or worker and never reports a destroy.
   */
  SMOLDOT_ACTIVE: 'smoldot.active',

  /** Mode detection plus engine start. */
  PROTOCOL_INIT: 'protocol.init',

  /** From SharedWorker creation to its ready signal. */
  PROTOCOL_SW_READY: 'protocol.sw_ready',

  PROTOCOL_MODE: 'protocol.mode',

  /** Count. The protocol frame could not read its session tuning, so the light client starts with defaults. */
  PROTOCOL_SESSION_TUNING: 'protocol.session_tuning',

  /**
   * Count. A held chain whose teardown threw as the pool closed it. Tagged `outcome` (error) and `reason` (the error's
   * name).
   */
  CHAIN_POOL_CLOSE: 'chain_pool.close',

  RESOLVE_STORAGE_READ: 'resolve.storage_read',

  /**
   * Read and validate one manifest text record. Tag `kind` (`root, app, widget, worker`) and `outcome`
   * (`ok, empty, invalid, error`) so "no manifest yet" is told apart from "malformed".
   */
  RESOLVE_MANIFEST_READ: 'resolve.manifest_read',

  /** Count. An unpin the light client refused while the follow ran, so pins pile up. Tag `outcome` and `reason`. */
  RESOLVE_UNPIN: 'resolve.unpin',

  /** Count. The boot's resolver warm-up failed. Expected. Tagged `outcome` (error) and `reason` (the error's name). */
  RESOLVE_WARMUP: 'resolve.warmup',

  /**
   * Count. The failure screen of a load whose product was already on screen threw. Tagged `outcome` (error) and
   * `reason` (the error's name).
   */
  RESOLVE_FAILURE_SCREEN: 'resolve.failure_screen',

  /** A cache read. Tag `outcome` (`hit, miss`) and `surface` (`cid_cache, block_cache`). */
  CACHE_READ: 'cache.read',

  CONTENT_GATEWAY: 'content.gateway',

  /** Whichever fetch method wins. */
  CONTENT_FETCH: 'content.fetch',

  /** From CID cache hit to content rendered. */
  E2E_FAST: 'e2e.fast_path',

  /** CID cache miss, then resolve, fetch and render. */
  E2E_SLOW: 'e2e.slow_path',

  /** One `bitswap_v1_get` round trip. Tag `outcome` (`ok, error, aborted`) and, on a failure, `reason` (the error name). */
  CONTENT_BITSWAP_RPC: 'content.bitswap_rpc',

  /** Blocks per content fetch, as a distribution: 1 for raw and N for dag-pb directories. */
  CONTENT_BITSWAP_BLOCKS: 'content.bitswap_blocks',

  /** A bitswap relay step that failed. Tag `outcome` (`error`), `reason` (the error name) and `step` (`verify, cache_read, cache_delete, cache_write`). */
  CONTENT_BLOCK_RELAY: 'content.block_relay',

  /** Bytes. */
  CONTENT_SIZE: 'content.size',

  CACHE_READ_LATENCY: 'cache.read_latency',

  CACHE_WRITE_LATENCY: 'cache.write_latency',

  /**
   * A cache's storage step that failed. Counted only on failure, tagged `outcome` (error), `reason` (the error's name),
   * `surface` (`cid_cache, block_cache`) and `step` (`read, write, touch, delete, evict, prune, clear`).
   */
  CACHE_STORAGE: 'cache.storage',

  /**
   * A cached copy checked against the network. Tag `outcome`: `match` (unchanged), `update` (the visitor is offered a
   * reload onto the newer version), `cleared` (evicted, and the page reloads when it showed the copy) or `error` (the
   * check failed and the entry is left as it was).
   */
  CACHE_REVALIDATE: 'cache.revalidate',

  CACHE_REVALIDATE_LATENCY: 'cache.revalidate_latency',

  /** Whole sandbox app load. */
  APP_TOTAL: 'app.total',

  APP_SW_REGISTER: 'app.sw_register',

  /**
   * Count. A full reset's wipe of the sandbox origin: `ok` once for a clean wipe, else one `error` per store it could
   * not wipe, with the store as the `reason`.
   */
  APP_ORIGIN_PURGE: 'app.origin_purge',

  /**
   * A sandbox run whose load rejected or whose failure could not be shown, both outside the load's own handling. Tagged
   * `outcome` and `reason` (`load_rejected`, `show_threw`, `fallback_missing` or `top_level`). `top_level` is a top-level
   * load of the sandbox, which is expected.
   */
  APP_RUN: 'app.run',

  /** Protocol iframe creation plus the wait for ready. */
  PROTOCOL_IFRAME_READY: 'protocol.iframe_ready',

  /**
   * Count. The boot's early start of the protocol frame failed. Expected. Tagged `outcome` (error) and `reason` (the
   * error's name).
   */
  PROTOCOL_FRAME_PREWARM: 'protocol.frame_prewarm',

  /**
   * A protocol frame lost after it was ready, so the host rebuilds it. Tagged `outcome` (error) and `reason` (the error's
   * name, `ProtocolPortReleasedError` for a tab the SharedWorker let go of while it was frozen).
   */
  PROTOCOL_FRAME_LOST: 'protocol.frame_lost',

  /**
   * A listener that threw, so it missed that delivery. Tagged `outcome` (error), `reason` (the error's name) and `owner`
   * (whose listeners, such as `chain_pool.status` or `debug_bus.replay`).
   */
  LISTENER_DELIVERY: 'listener.delivery',

  PROTOCOL_REQUEST: 'protocol.request',

  /**
   * A protocol message dropped on receipt. Tagged `outcome` (refused), `side` (host, frame or worker) and `reason`:
   * `malformed` for bytes that are no message, `invalid` for a message whose values its method refuses, `not_bytes` for
   * data that is not an `ArrayBuffer`, which a host page of an earlier release sends, and `origin` for the first bytes from
   * each page outside the frame's trust boundary.
   */
  PROTOCOL_WIRE_REFUSED: 'protocol.wire_refused',

  /**
   * A protocol message a side could not post, so its peer never hears it. Tagged `outcome` (error), `side` (host, frame or
   * worker) and `reason` (the error's name).
   */
  PROTOCOL_SERVE_POST: 'protocol.serve_post',

  /**
   * A chain message from the protocol frame that the host could not parse, so its connection never hears it. Tagged
   * `outcome` (error) and `reason` (the error's name).
   */
  PROTOCOL_CHAIN_MESSAGE: 'protocol.chain_message',

  /**
   * A feed the protocol frame ended while it stayed up, so the host reopens it after a backoff. Tagged `outcome` (error),
   * `feed` (shared_auth or telemetry) and `reason` (the error's name, `ProtocolFeedEndedError` for an end without one).
   */
  PROTOCOL_FEED_END: 'protocol.feed_end',

  /**
   * The light client's byte meter could not be read on a tick, so the speed readout misses that reading. Counted once per
   * run of failed reads. Tagged `outcome` (error) and `reason` (the error's name).
   */
  PROTOCOL_NET_BYTES_READ: 'protocol.net_bytes_read',

  /**
   * One request as the SharedWorker served it, tagged with the asking tab's `resolution_id`.
   * Apart from `PROTOCOL_REQUEST` because it excludes the postMessage hops.
   */
  PROTOCOL_WORKER_REQUEST: 'protocol.worker_request',

  /**
   * A heartbeat the protocol frame could not send the SharedWorker, so it stops answering the worker's beats and the
   * worker lets go of its port. Tagged `outcome` (error) and `reason` (the error's name).
   */
  PROTOCOL_WORKER_HEARTBEAT: 'protocol.worker_heartbeat',

  /**
   * A shared auth or wallet change the protocol frame could not post to the other tabs, tagged `outcome` (error) and
   * `reason` (the error's name).
   */
  PROTOCOL_SHARED_AUTH_BROADCAST: 'protocol.shared_auth_broadcast',

  /**
   * The People chain the protocol frame or its SharedWorker warms in the background failed to sync, so the first read of
   * People waits on it instead. Tagged `outcome` (error) and `reason` (the error's name).
   */
  PROTOCOL_PEOPLE_WARM: 'protocol.people_warm',

  /** An error event the protocol SharedWorker fired after it was ready. Tagged `outcome` (error) and `reason` (the error's name). */
  PROTOCOL_SHARED_WORKER_ERROR: 'protocol.shared_worker_error',

  /**
   * A sandbox message handler on the host that threw. Tagged `outcome` (error) and `reason` (the error's name), as the
   * sandbox then gets no answer.
   */
  SANDBOX_HANDLER: 'sandbox.handler',

  /** A failed registration of the sandbox service worker. Tagged `outcome` (error) and `reason` (the error's name). */
  SANDBOX_SW_REGISTER: 'sandbox.sw_register',

  /**
   * A failed freshness check or update of the sandbox service worker. Tagged `outcome` (error) and `reason` (the
   * error's name). An update the browser refuses as expected (`TypeError`, `InvalidStateError`) is counted too.
   */
  SANDBOX_SW_UPDATE: 'sandbox.sw_update',

  /**
   * An abort the sandbox's block bridge could not post to the host after a request timed out. Tagged `outcome` (error)
   * and `reason` (the error's name).
   */
  SANDBOX_BITSWAP_ABORT: 'sandbox.bitswap_abort',

  /**
   * Count. The shell's service worker module could not load. Tagged `outcome` (error) and `reason` (the error's name).
   */
  PWA_SW_LOAD: 'pwa.sw_load',

  /**
   * Count. The shell's service worker could not register. Tagged `outcome` (error) and `reason` (the error's name).
   */
  PWA_SW_REGISTER: 'pwa.sw_register',

  /**
   * Count. An update check of the shell's service worker failed, offline, mid-deploy or after storage was cleared.
   * Expected, since the next check retries. Tagged `outcome` (error) and `reason` (the error's name).
   */
  PWA_SW_UPDATE: 'pwa.sw_update',

  /**
   * Count. A step of the scheduled notifications poll failed, once per failing run of the step. Tagged `outcome`
   * (error), `reason` (the error's name) and `step` (`remove_stale, list_pending, claim`). An IndexedDB failure the
   * browser causes is expected, the rest captured.
   */
  NOTIFICATIONS_POLL: 'notifications.poll',

  /** Dynamic import of the container chunk. */
  BRIDGE_CHUNK_LOAD: 'bridge.chunk_load',

  BRIDGE_SETUP: 'bridge.setup',

  /** Measured with a PerformanceObserver. */
  WASM_LOAD: 'wasm.load',

  /**
   * Shared-storage request rejected before touching `localStorage`. Tagged `store` and `reason`,
   * because the failed answer the caller receives is easy to miss.
   */
  SHARED_STORAGE_REJECTED: 'shared_storage.rejected',

  /**
   * One read of the login session shared across subdomains. Tagged `outcome` (hit, miss or error) and, on error,
   * `reason`, because a failed read shows the login screen exactly like a missing session.
   */
  SHARED_SESSION_READ: 'shared_session.read',

  /**
   * One read of the mode settings shared across subdomains. Tagged `outcome` and, on error, `reason`, because a failed
   * read falls back to this origin's settings without a sign.
   */
  SHARED_MODE_READ: 'shared_mode.read',

  /** Local wallet boot, activation and identity steps. Tagged `outcome` and, on failure, `reason`. */
  WALLET_LOCAL_ACTIVATE: 'wallet.local_activate',

  /**
   * One redial of the page's wallet core after the core was taken out of service. Tagged `outcome` (ok, error or aborted,
   * when a product change dropped it) and `reason`, what took the core out, as a failed one leaves the page without a
   * core.
   */
  WALLET_CORE_REDIAL: 'wallet.core_redial',

  /**
   * Count. Telling a pairing core that the stored session changed threw, so the core may miss a login from another tab.
   * Tagged `outcome` (error) and `reason` (the error's name).
   */
  PAGE_CORE_SESSION_FOLLOW: 'page_core.session_follow',

  /**
   * One `acquire` the session lease made of the page core. Tagged `outcome` (ok or error) and, on error, `reason`: `boot`
   * for a first boot that failed and `redial` for a replacement that could not boot.
   */
  WALLET_SESSION_LEASE: 'wallet.session_lease',

  /**
   * A render the product frame started on its own: on a replacement core, after a device permission change or at a
   * reloaded sandbox's ask. Tagged `outcome` (ok, error, or aborted when a newer render or a core loss took over) and
   * `reason` (which of those, or `core_deaths` once the frame stopped rendering on cores that kept dying), as no caller
   * is there to report it.
   */
  PRODUCT_RERENDER: 'product.rerender',

  /**
   * Count. A login on the page core failed. Tagged `outcome` (error) and `reason`: the core's refusal tag for a
   * `LoginRequestError`, else the error's name. A cancel, a deny and a redial the page core gave up on are expected,
   * the rest captured.
   */
  WALLET_LOGIN: 'wallet.login',

  /**
   * Count. The product's icon could not be read within its budget, so the tab keeps its icon. Expected. Tagged
   * `outcome` (error) and `reason` (the error's name).
   */
  PRODUCT_ICON: 'product.icon',

  /**
   * A frame on the topbar login's own connection that the login skipped and survived. Tagged `outcome` (error) and
   * `reason` (`undecodable_frame`, a frame that did not decode, counted once per login).
   */
  WALLET_LOGIN_FRAME: 'wallet.login_frame',

  /**
   * A page's sign-out of a paired session. Tagged `outcome` (`ok` once the phone was told) and, on error, `reason`:
   * `read` for a copy that could not be read, `end` for a session that could not be activated or ended on the ending
   * core, so the phone was not told, `drop` for a local-mode sign-out whose paired copy could not be dropped, on a page
   * that pairs in place or on a product whose flag is unreadable, where a copy it could not read counts too, and
   * `no_window` for a local-mode sign-out on a page that pairs in place, which lets the paired copy go without telling
   * the phone. A paired sign-out counts once, and a core or copy that could not let go is reported as an issue only.
   */
  WALLET_LOGOUT: 'wallet.logout',

  /** One read of the loaded product's permissions. Tagged `outcome` and, on error, `reason`, as a failed one leaves the menu without statuses. */
  PERMISSIONS_READ: 'permissions.read',

  /**
   * A permission change, from the panel or a prompt, counted once when it settles. Tagged `outcome` and, on error,
   * `reason` (`write`), as a failed one leaves the permissions it names as they were.
   */
  PERMISSIONS_CHANGE: 'permissions.change',

  /**
   * One failed read of the chat store: the panel's contacts or messages, after which the panel keeps its last view, or
   * a product's room list, which then rejects to its caller. Tagged `outcome` (error) and `reason` (the error's name).
   */
  CHAT_READ: 'chat.read',

  /**
   * Count. The worker manifest read that tells whether a product declares chat failed, so chat is off for that load.
   * Tagged `outcome` (error) and `reason` (the error's name).
   */
  CHAT_CAPABILITY: 'chat.capability',

  /**
   * One Share diagnostic click in the debug panel. Tagged `outcome` and, on error, `reason`, as a failed one opens no
   * issue.
   */
  DIAGNOSTICS_SHARE: 'diagnostics.share',

  /**
   * One drawing of the sign-in QR code. Tagged `outcome` and, on error, `reason`, as a failed one leaves the sign-in on
   * its spinner with nothing to scan.
   */
  AUTH_QR_RENDER: 'auth.qr_render',

  /**
   * Count. A sign-in command threw after the bridge chunk loaded. Tagged `outcome` (error), `reason` (the error's
   * name) and `step` (`login, logout, cancel_login`).
   */
  AUTH_COMMAND: 'auth.command',

  /**
   * Count. The sign-in modal's lease failed other than by its own abort. Tagged `outcome` (error) and `reason` (the
   * error's name).
   */
  AUTH_MODAL_LEASE: 'auth.modal_lease',

  /**
   * One settings reset: Save & Apply or Clear all in the settings, a link that changes a saved choice, or the failure
   * screen's backend switch. Tagged `outcome` and, on error, `reason` (the step that failed: `wipe`, `cid_cache`,
   * `block_cache` or `pending_reset`, or the error's name for a step that threw), as the reload follows either way.
   */
  SETTINGS_APPLY: 'settings.apply',

  /** One part of an origin wipe that failed. Tagged `outcome` (error) and `reason` (indexeddb, cache_storage or service_worker). */
  ORIGIN_WIPE: 'settings.origin_wipe',

  /**
   * A purge request that could not be read on boot. Tagged `outcome` and `reason` (the storage error's name), as the
   * boot then goes ahead without the purge.
   */
  PENDING_RESET_READ: 'pending_reset.read',

  /**
   * A purge request the failure screen could not store before its reload. Tagged `outcome` and `reason`, as the reload
   * then comes up on the chain database it had.
   */
  PENDING_RESET_SCHEDULE: 'pending_reset.schedule',

  /**
   * One failed read, write or clear of the cached account shown before the session is read. Tagged `outcome` (error, or
   * invalid for a cache that does not parse) and `reason` (`read`, `write`, `clear` or `json`), as a failure shows a
   * stale name or none.
   */
  SHARED_SESSION_UI_CACHE: 'shared_session.ui_cache',

  /**
   * One finalized height the diagnostics report asks a chain for. Tagged `outcome` (ok, error or timeout) and, on
   * failure, `reason`, as a failed one prints n/a.
   */
  DIAGNOSTICS_FINALIZED_BLOCK: 'diagnostics.finalized_block',

  /**
   * A failed read or write of the recently visited names in the shared store. Tagged `outcome` and `reason` (`read`,
   * `write` or `migrate`), as the list then lives in this origin only.
   */
  RECENT_LABELS_UPDATE: 'recent_labels.update',

  /**
   * A chunk Vite's preload helper failed to load, mostly a deploy that replaced it. Tagged `outcome` and `reason` (the
   * error's name). The caller of the import counts the failure with a breadcrumb, so this reads as the rate behind those.
   */
  CHUNK_PRELOAD: 'chunk.preload',

  /**
   * A clipboard write the debug panel's copy controls could not make, mostly the browser's refusal. Tagged `outcome`
   * (error) and `reason` (the error's name), as the control then shows a cross.
   */
  DEBUG_PANEL_COPY: 'debug_panel.copy',

  /** One start of the debug panel in debug mode. Tagged `outcome` and, on error, `reason`, as a failed one shows no panel. */
  DEBUG_PANEL_LOAD: 'debug_panel.load',

  /** A lazy chunk a caller could not load and went on without. Tagged `outcome` and `reason` (the caller's step). */
  LAZY_CHUNK_LOAD: 'lazy_chunk.load',

  /** One flush of buffered telemetry before a context closes. Counted only when the flush threw, tagged `outcome` and `reason` (the error's name). */
  TELEMETRY_FLUSH: 'telemetry.flush',

  /**
   * The at-rest key of the core's secret slots. Tagged `outcome` (error) and `reason`: `ephemeral_key` when IndexedDB
   * cannot keep it, so this session's secrets will not decrypt after a reload, or `undecryptable` for a slot dropped
   * because it no longer decrypts.
   */
  CORE_STORAGE_SECRET: 'core_storage.secret',

  /**
   * A stored core value that could not be decoded, which then reads as absent. Tagged `outcome` (error) and `reason`
   * (`corrupt`).
   */
  CORE_STORAGE_READ: 'core_storage.read',

  /**
   * A read of a product's storage for its subscription that failed. Tagged `outcome` (error) and `reason` (the error's
   * name), as the product then hears only a read failure.
   */
  PRODUCT_STORAGE_WATCH: 'product_storage.watch',

  /**
   * One write of a mode setting shared across subdomains. Tagged `outcome` and, on error, `reason`, as a failed one leaves
   * the other subdomains on the old setting.
   */
  SHARED_MODE_WRITE: 'shared_mode.write',

  /**
   * One preimage lookup a product asked for. Tagged `outcome` and, on error, `reason`: `fetch` once per lookup whose
   * backend keeps failing while the poll retries, or `mismatch` for bytes that do not hash to the key.
   */
  PREIMAGE_LOOKUP: 'preimage.lookup',

  /**
   * A new lease on a host chain after its transport halted. Tagged `outcome` and, on error, `reason`: `no_transport` when
   * the backend no longer serves the chain, `halted` when the new lease halted at once, or the error's name.
   */
  TRUAPI_CHAIN_REOPEN: 'truapi_chain.reopen',

  /**
   * Count. A phone-bound request a waiting step followed to its end. Tagged `outcome` (`ok, refused, aborted, error,
   * gone, undecodable, unmatchable`) and `reason` (the method). A claim's end carries `background`, and a claim whose
   * answer did not decode ends as `undecodable`. A request that did not decode and a review that matched no request are
   * counted on their own, without `background`.
   */
  PHONE_REQUEST: 'signing.phone_request',

  /**
   * Count. The phone request tap threw on a frame, so that frame went untracked. Tagged `outcome` (error), `reason`
   * (the error's name) and `side` (`product, core`).
   */
  PHONE_REQUEST_TAP: 'signing.phone_request_tap',

  /**
   * Count. The notice of a phone request's end threw. Tagged `outcome` (error), `reason` (the error's name) and
   * `method`.
   */
  PHONE_REQUEST_NOTICE: 'signing.phone_request_notice',

  /**
   * A view an answered dialog was to hand its place to that could not be built, so the dialog closed instead. Tagged
   * `outcome` (error) and `reason` (the error's name).
   */
  MODAL_HANDOFF: 'modal.handoff',

  /**
   * Count. What the signed-in flag did to a stored sign-in as a reader went over it. Tagged `outcome`: `dropped` once for
   * each pass of the restore rule that dropped a stored session because the flag was gone, `unreadable` once per page
   * whose flag could not be read so session restore kept what it found, never for a preview its preview host frames,
   * whose flag reads unknown by design, and `error` for a saved session the store would not clear. Tagged `reason`, the
   * reader: `load` for a page's load, `visible` for an open page becoming visible, `window` for the sign-in or sign-out
   * window over the main store.
   */
  SESSION_PRESENCE: 'session.presence',

  /**
   * Count. What an open page did as it became visible and found the signed-in flag changed. Tagged `outcome`:
   * `signed_out` for a page it signed out, `switched` for a page it reloads onto a local wallet replaced elsewhere, and
   * `error` for a sign-out that failed after its retries. Tagged `reason` (`visible`).
   */
  SESSION_PRESENCE_WATCH: 'session.presence_watch',

  /**
   * Count. A read of the signed-in flag threw, so presence answered unknown. Counted once for each read that threw,
   * whoever read it, so one page may count several. Expected. Tagged `outcome` (error) and `reason` (the error's
   * name).
   */
  SESSION_PRESENCE_READ: 'session.presence_read',

  /**
   * Count. A wallet read made to check the page's sign-in failed. Expected. Tagged `outcome` (error) and `reason` (the
   * error's name).
   */
  SESSION_WALLET_READ: 'session.wallet_read',

  /**
   * Count. A write of the signed-in flag that failed, so other subdomains read the old flag. Tagged `outcome` (`error`)
   * and `reason`, the write (`set`, `clear`, or `renew` for a renew of a flag that is still set).
   */
  SESSION_FLAG_WRITE: 'session.flag_write',

  /**
   * Count. A page's ask to sign in through the sign-in window. Tagged `outcome`: `opened` for a window it opened,
   * `blocked` for one the browser refused, and `busy` for an ask while the sign-out window was still open, which opened
   * no window. Tagged `reason`, the intent (`signin, phrase, resume`).
   */
  SESSION_WINDOW_SIGNIN: 'session_window.signin',

  /**
   * Count. How a sign-in round through the window ended. Tagged `outcome` and `reason`, what ended it: `signed_in` with
   * `window` for the window's result, or with `store` for a page that heard the window store the sign-in before its
   * result came, `refused` with `window`, `cancelled` with `closed` for a window found closed when the page came back,
   * `page` for the page's own Cancel or a window it opened in place of the round's, or `signed_out` for a sign-out that
   * ended it.
   */
  SESSION_WINDOW_ROUND: 'session_window.round',

  /**
   * Count. A sign-in window's result the page could not write into its copy. Tagged `outcome` (`error`) and `reason`,
   * the round's intent (`signin, phrase, resume`).
   */
  SESSION_WINDOW_APPLY: 'session_window.apply',

  /**
   * Count. A step of the sign-in window's own flow that failed, so the window reported it and showed a failure where the
   * view has room. Tagged `outcome` (`error`) and `reason`, the step: `decide`, `continue`, `another`, `phrase`, `back`,
   * `pairing` and `finish`.
   */
  SESSION_WINDOW_FLOW: 'session_window.flow',

  /**
   * Count. A page's opening of the sign-out window. Tagged `outcome` (`opened, blocked`) and `reason`, whether the page
   * told the phone itself (`notified, unnotified`).
   */
  SESSION_WINDOW_SIGNOUT: 'session_window.signout',

  /**
   * Count. How the sign-out window's own sign-out ended. Tagged `outcome`: `told_phone` for a paired session it ended on
   * its own core, `cleared` for a store it cleared without telling the phone, `nothing` for a store that held nothing,
   * `kept` for a signed-in flag still set or unreadable, or set again by a sign-in elsewhere before the window cleared,
   * so it left the store as it found it, and `error` for a step that failed while it still cleared what it could, or a
   * boot that failed before it could sign out, which its own issue tells apart. Tagged `reason`, whether the page told
   * the phone itself (`notified, unnotified`). An answer to the page that failed counts once more, apart from how the
   * sign-out ended, as `error` with `answer`.
   */
  SESSION_WINDOW_SIGNOUT_RESULT: 'session_window.signout_result',

  /**
   * Count. A sign-in window that refused its opener, since a page outside the opener rule tried to sign in through it.
   * Tagged `outcome` (`refused`) and `reason`, the rule's verdict: `app` for a product origin, `foreign` for another
   * domain, `insecure` for a wrong scheme, `port` for a wrong port, `localhost` for a local opener of a deployed window
   * and `malformed` for an origin that is not a bare one.
   */
  SESSION_WINDOW_REFUSED: 'session_window.refused',

  /**
   * Count. How a site's sign-in round through the session window went. Tagged `outcome` and `reason`: `granted` with
   * `new` for a site the user signed in to for the first time, `known` for one the main store already keeps or `group`
   * for a site of a group, new or known, `refused` with the reason the window posted, a site's sign-out request included,
   * or with why a redirect sign-in failed its vetting, counted though nothing is sent (`unsupported_browser` for a
   * browser without X25519, `bad_key` for a site key no secret derives with, `return_to_party` for a return address of no
   * site, `return_to_not_listed` or `well_known_unreachable` for one the site's well-known file does not list),
   * `cancelled` with `page` for the window's own Cancel or `phone` for a request the user rejected on the phone, and
   * `error` with the step whose failure shows, with or without Try again (`main_account`, `account`, `sign`, or `action`
   * for a failure of the round that names no step), with the grants store call that failed while the round went on
   * (`grant`, `grant_read`, `grant_forget`, `grant_touch`), with `group_list` for a Public Suffix List that did not load,
   * beside the `refused` with `bad_request` of the group's request, or with `seal` for a redirect answer the window could
   * not seal. A new grant that could not be saved counts `error` with `grant`, and the round still counts `granted` with
   * `new` or `group`, since the site gets its result without a token. `granted`, `refused` and `cancelled` count once per
   * round, `error` each time it happens.
   */
  SITE_SIGN_IN: 'session_pages.site_sign_in',

  /**
   * Count. How a site's transaction round through the session window went. Tagged `outcome` and `reason`: `signed` for a
   * transaction the site got signed, with `new` for a site the user granted in this round, `known` for one the main store
   * already keeps or `group` for a site of a group, new or known, `refused` with the reason the window posted, including
   * a bad request or payload the window refused before the round, `cancelled` with `page` for the window's own Cancel or
   * `phone` for a transaction the user rejected on the phone, and `error` with the step whose failure shows, with or
   * without Try again (`main_account`, `account`, `chain`, `build`, or `action` for a failure of the round that names no
   * step), with the grants store call that failed while the round went on (`grant`, `grant_read`, `grant_forget`,
   * `grant_touch`), or with `group_list` for a Public Suffix List that did not load, beside the `refused` with
   * `bad_request` of the group's request. A new grant that could not be saved counts `error` with `grant`, and the round
   * still counts `signed` with `new` or `group`, since the site gets its result without a token. A chain session that
   * could not be closed counts `error` with `chain` beside the round's outcome. `signed`, `refused` and `cancelled` count
   * once per round, `error` each time it happens.
   */
  SITE_TRANSACTION: 'session_pages.site_transaction',

  /**
   * Count. A Revoke the user pressed on the site list, or a sign-out whose forget of every grant failed. Tagged `outcome`
   * and `reason`: `revoked` with `user` for a grant forgotten, `failed` with `user` for one the grants store could not
   * forget, and `error` with `sign_out` for a sign-out, on a page or in the sign-out window, whose grants the store
   * could not forget, so the sites kept their tokens.
   */
  SITE_REVOKE: 'session_pages.site_revoke',

  /** Count. A read of the site list that failed. Tagged `outcome` `error` and `reason` `read`. */
  SITE_LIST: 'session_pages.site_list',
} as const;
