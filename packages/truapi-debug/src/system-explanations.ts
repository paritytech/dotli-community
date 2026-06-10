// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Long-form explanations for every system event.
//
// The one-line `summariseSystemEvent` strings tell the reader *what*
// an event captures. These entries tell them *what is happening in the
// system* at that moment: which subsystem is active, what state just
// changed, and what the downstream dependencies are. Surfaced in the
// detail pane via a collapsible "What is this?" section.
//
// Keyed by `layer:event`. Every emit site must have an entry. The
// test below (and the fallback) catches any drift.

interface SystemExplanation {
  /** Short title shown on the collapsible summary. */
  title: string;
  /**
   * Prose body. Line breaks are preserved. Aim for 3–6 sentences
   * describing the phase, its triggers, and what it unblocks next.
   */
  body: string;
}

const EXPLANATIONS: Record<string, SystemExplanation> = {
  // boot

  "boot:started": {
    title: "Host boot started",
    body: `The host application has begun executing \`main()\` in \`apps/host/src/main.ts\`. At this point the browser URL has not been parsed yet, the topbar is not mounted, and no network requests have gone out — but the chosen mode and backend preferences have already been read from localStorage.

This is the very first application-level event you'll see in a tab. Everything downstream (resolver, render, bridge, product boot) follows from here, and every boot-layer event in this group shares the same \`flowId\`.`,
  },

  "boot:protocol_warmup_started": {
    title: "Protocol iframe warmup started",
    body: `The hidden protocol iframe at \`host.app.dot.li\` is being pre-warmed so it can service chain calls the instant a sandboxed product needs one. The submode dictates the plumbing inside that iframe: \`shared-worker\` shares a smoldot instance with other tabs via a SharedWorker; \`direct\` starts smoldot on the iframe's own main thread; \`rpc\` bypasses smoldot and connects to a WebSocket JSON-RPC endpoint.

Warmup happens in the background and is non-blocking. If a product calls chain services before warmup finishes, the protocol iframe queues the call and drains it once ready.`,
  },

  "boot:topbar_ready": {
    title: "Top bar UI initialised",
    body: `The DOM for the top bar (logo, URL pill, auth/theme/mode buttons) has been wired. The auth module itself is not loaded yet — it's lazy-imported on first interaction, so a pairing flow only pulls in the SDK when the user actually clicks the sign-in button.`,
  },

  "boot:url_parsed": {
    title: "URL inspected",
    body: `The current browser URL has been classified into one of three outcomes:

• \`label\` set — a product subdomain (e.g. \`hackme3.localhost\` or \`hackme3.dot.li\`) that will be resolved next.
• \`localhostHost\` set — a \`/localhost:PORT\` path; the host will proxy directly to that dev server without resolving any \`.dot\` name.
• Both null — the host URL itself (no subdomain), so the landing page is shown.

\`deepPath\` captures any path / search / hash fragment that will be forwarded into the product iframe after resolution.`,
  },

  "boot:cid_cache_checked": {
    title: "CID cache lookup",
    body: `Checked the persistent CID cache (\`@dotli/storage/cid-cache\`, IndexedDB) for a previously resolved \`label → cid\` mapping. A hit triggers the **fast path**: skip resolution entirely, render the cached CID, save ~1–5 seconds of boot time. A miss triggers the **slow path**: run the full resolver against the chosen chain backend.

The cache is populated at the end of each successful slow-path resolution (\`resolve:completed\`) unless the user has explicitly disabled caching in settings.`,
  },

  "boot:landing_page_shown": {
    title: "Landing page rendered",
    body: `The host URL had no product subdomain to resolve, so \`showLanding()\` rendered the marketing landing page and \`main()\` returned. Boot ends here; no product iframe, no bridge, no TrUAPI traffic.`,
  },

  "boot:ready": {
    title: "Host boot complete",
    body: `The host has finished bringing up everything it needs for this tab. \`totalMs\` is wall-clock from the page load to this moment. The \`path\` field distinguishes how the tab got here:

• \`fast\` — CID cache hit, went straight to rendering.
• \`slow\` — full resolution ran against smoldot or the RPC gateway.
• \`localhost\` — localhost proxy path (developer workflow).

After this event, the TrUAPI bus starts producing traffic and the product is driving the timeline.`,
  },

  "boot:failed": {
    title: "Host boot failed",
    body: `Boot hit an unrecoverable error before the product could render. The user sees an error card with a "try the other backend" button; clicking that button fires a \`failover:chain_backend\` event and reloads.

\`dependency\` identifies which subsystem failed: \`smoldot\` for light-client issues (bootnode connectivity, chain sync timeout, panics) or \`asset-hub-rpc\` for RPC endpoint failures (DNS, 502, read timeout).`,
  },

  // resolve

  "resolve:started": {
    title: "Name resolution started",
    body: `Beginning to resolve \`<label>.dot\` to its content CID. Two code paths exist:

• \`smoldot\` — runs a local WASM light client in the protocol iframe, syncs Asset Hub Paseo trustlessly, reads the \`dotns\` Solidity contract's ContentHash storage slot directly, and returns the decoded CID. Takes seconds to a minute on cold start.
• \`rpc-gateway\` — opens a WebSocket to a trusted RPC endpoint and issues a \`state_getStorage\` call against the same slot. Sub-second but relies on the gateway's honesty.`,
  },

  "resolve:phase": {
    title: "Resolver progress",
    body: `A progress message from the resolver, mapped to a canonical phase identifier. In smoldot mode the phases trace the light-client lifecycle: \`light-client-starting\`, \`relay-chain-adding\`, \`asset-hub-connecting\`, \`asset-hub-syncing\`, \`asset-hub-ready\`, \`resolving-content\`. In RPC mode the messages are terser (\`connecting\`, \`querying storage\`).

These events drive the loading UI's phase bar and ship to this panel so you can see exactly where a slow resolution is stuck.`,
  },

  "resolve:storage_read": {
    title: "Storage read against dotns",
    body: `The resolver has read the \`dotns.ContentHash(namehash(label))\` Solidity storage slot on Asset Hub Paseo. The returned bytes are then decoded as an EIP-1577 IPFS contenthash (\`0xe3 01 70 12 20 …\`) to yield the raw CID hex.

\`bytes\` is the raw byte length returned; \`durationMs\` is the wall-clock for the storage read (excludes prior chain sync time).`,
  },

  "resolve:completed": {
    title: "Name resolution complete",
    body: `Resolution succeeded. Two outcomes:

• \`cid\` is a string — the label points to a published CID. The host will render the product from \`<cid>.app.dot.li\` next.
• \`cid === null\` — the label exists on-chain but has no ContentHash set. The owner needs to submit a preimage on Bulletin Chain and update the contract before anyone can load this domain.

\`durationMs\` is the full resolver time, from \`resolve:started\` to this event.`,
  },

  "resolve:failed": {
    title: "Name resolution failed",
    body: `Resolution raised an exception. Common causes by source:

• \`smoldot\` — bootnode handshake failure, chain-sync timeout, smoldot panic, asset-hub unavailable.
• \`rpc-gateway\` — DNS failure, TLS handshake error, WebSocket closed before response, endpoint returned an error code, or the storage decoder rejected the response.

The host catches this and emits a \`boot:failed\` event (or a user-facing error with a failover button).`,
  },

  // render

  "render:iframe_begin": {
    title: "Product iframe creation starting",
    body: `The host is about to insert an \`<iframe>\` into the DOM for the product. Two modes:

• \`iframe\` — plain embed of the URL directly (localhost dev-server proxy).
• \`subdomain\` — the full sandboxed flow: an iframe pointing at \`<label>.app.dot.li\` where the sandbox origin is responsible for fetching the CID's content, decompressing the archive, and rendering the product into its own nested iframe. The host stays the cross-origin bridge.

The iframe's \`sandbox\` and \`allow\` attributes are configured here based on the label's per-product permissions.`,
  },

  "render:iframe_ready": {
    title: "Product iframe ready",
    body: `The iframe element is in the DOM and has started navigating to its URL. The product itself has not executed yet — that happens asynchronously as the browser loads the iframe content. Next up is the TrUAPI bridge setup, which runs in parallel.`,
  },

  // bridge

  "bridge:sso_listeners_ready": {
    title: "SSO bridge listeners ready",
    body: `The host has installed the window-level listeners that connect the topbar login/logout UI to the Rust-backed landing-auth core. After this point, a topbar login click can dispatch \`dotli:truapi-login-request\` and expect the bridge to create or reuse the host-global SSO core.`,
  },

  "bridge:setup_begin": {
    title: "TrUAPI bridge wiring",
    body: `Starting to wire the Rust-backed TrUAPI bridge between the host and the product iframe. This bridge carries **all** TrUAPI traffic: account derivation, transaction signing, chain connections, scoped localStorage, statement-store subscriptions, preimage submission, permissions prompts, push notifications.`,
  },

  "bridge:setup_ready": {
    title: "TrUAPI bridge ready",
    body: `The primary bridge is live. From this moment on, every TrUAPI message exchanged with the product fires on the TrUAPI hook and appears in this panel's TrUAPI swimlane(s).

If the product calls \`handleChainConnection()\` the host will create a \`ChainProvider\` pointing at smoldot or an RPC endpoint; if it subscribes to a \`chainHead.follow\` you'll see a rail light up in its chain swimlane.

**\`setup_ready\` only means the host is _listening_**, not that traffic has started. The next few events (\`iframe_load\`, \`first_inbound\`, \`first_outbound\`) anchor the window during which the product iframe is still loading and the handshake retry loop is firing without a response yet.`,
  },

  "bridge:iframe_load": {
    title: "Product iframe loaded",
    body: `The browser has fired the product iframe's \`load\` event. For the \`iframe\` mode that means the dApp's own HTML has finished loading; for the \`subdomain\` mode it's the sandbox shell at \`<label>.app.dot.li\` that's loaded — the inner dApp iframe is still being mounted and bootstrapped by the sandbox.

This is a common culprit for the gap between \`setup_ready\` and the first \`host_handshake_response\`: if the iframe takes many seconds to load (cold IPFS gateway, slow archive fetch), the product can't post anything to the host yet, so the host sits there with nothing to reply to.`,
  },

  "bridge:first_inbound": {
    title: "First inbound bridge message",
    body: `The host's bridge provider has just delivered its first \`postMessage\` from the product iframe. Typically this is a \`host_handshake_request\` — but it may be the Nth retry if the product has been re-trying every 50ms while the host was still wiring up.

Gaps between \`setup_ready\` and \`first_inbound\` mean the product iframe wasn't talking yet — either its JS hadn't started executing, or it was still initialising its own transport/sandbox relay before it could post anything.`,
  },

  "bridge:first_outbound": {
    title: "First outbound bridge message",
    body: `The host has just posted its first TrUAPI message **to** the product iframe. For the \`host_handshake_request\` loop, this is the handshake response and effectively "closes" the bridge flow — from here on, normal request/response traffic flows both directions.

Gaps between \`first_inbound\` and \`first_outbound\` imply a host-side problem (the handler wasn't registered, or the main thread was blocked). Under normal conditions these two events land in the same millisecond.`,
  },

  // sso

  "sso:login_event_received": {
    title: "Topbar login requested",
    body: `The topbar dispatched a host-global login request. The next step is to prepare the landing-auth Rust core, separate from any currently loaded product iframe, so pairing is scoped to the host SSO session rather than a product.`,
  },

  "sso:login_host_ready": {
    title: "Landing auth core ready",
    body: `The host-global SSO core is ready to receive the login request. This is an intermediate state, not a terminal event: the flow is still waiting for \`login_request_response\`, a failure event, or a later pairing/session event.`,
  },

  "sso:login_request_start": {
    title: "Login request encoding started",
    body: `The host is encoding an \`account.request_login\` frame for the Rust core. The request id in the payload is the correlation key for the request and response frames.`,
  },

  "sso:login_request_sent": {
    title: "Login request sent",
    body: `The encoded login request has been posted to the Rust core provider. From here the core may restore an existing session, present a QR pairing request, or fail while preparing the pairing transport.`,
  },

  "sso:login_request_response": {
    title: "Login request completed",
    body: `The Rust core returned a typed login result. \`Success\` and \`AlreadyConnected\` establish a connected session; \`Rejected\` is treated as user cancellation and should close the pending login state rather than showing a retry/error modal.`,
  },

  "sso:login_request_failed": {
    title: "Login request rejected",
    body: `The Rust core returned a typed domain error for the login request. This closes the request/response portion of the flow; the payload remains intentionally small because the typed error is also surfaced through the topbar login-error path.`,
  },

  "sso:login_request_encode_failed": {
    title: "Login request encode failed",
    body: `The host could not encode the login request frame. This is a host-side protocol bug or version mismatch and happens before anything is sent to the Rust core.`,
  },

  "sso:login_request_send_failed": {
    title: "Login request send failed",
    body: `The host encoded the request but failed while posting it to the core provider. Usual causes are a disposed provider, worker fault, or render/logout race that tore down the landing-auth core.`,
  },

  "sso:login_request_decode_failed": {
    title: "Login response decode failed",
    body: `A response arrived for the login request, but the host could not decode it as the expected \`account.request_login\` result. Treat this as a wire-version mismatch until proven otherwise.`,
  },

  "sso:present_pairing_callback": {
    title: "Pairing QR requested",
    body: `The Rust core asked the host to present a pairing deeplink. The topbar renders this as the Polkadot Mobile QR modal and receives a cancel callback that can abort the in-flight pairing request.`,
  },

  "sso:pairing_started": {
    title: "SSO pairing started",
    body: `A new SSO pairing attempt has started. The host has a deeplink label and is preparing the modal state; the core will subscribe to statement-store messages carrying the pairing response.`,
  },

  "sso:deeplink_generated": {
    title: "Pairing deeplink generated",
    body: `The QR/deeplink payload has been generated for Polkadot Mobile. Scanning it moves the flow to the mobile companion app; the desktop host waits for a matching statement-store response.`,
  },

  "sso:awaiting_response": {
    title: "Waiting for mobile response",
    body: `The QR is visible and the core is waiting for Polkadot Mobile to publish the SSO response statement. If this remains pending, inspect the nearby \`statement_store_*\` events to see whether subscription setup or query polling is failing.`,
  },

  "sso:statement_store_connecting": {
    title: "Statement-store connecting",
    body: `The host is opening the chain/RPC connection used by the Rust core's SSO statement-store transport. The backend and genesis hash identify which chain path is being used for pairing traffic.`,
  },

  "sso:statement_store_connected": {
    title: "Statement-store connection ready",
    body: `The statement-store transport wrapper is ready to accept JSON-RPC requests from the Rust core. Subsequent request/response events show the subscribe, query, and unsubscribe calls used by the pairing poller.`,
  },

  "sso:statement_store_connect_failed": {
    title: "Statement-store connection failed",
    body: `The host could not create the chain/RPC transport required for SSO pairing. Pairing cannot proceed until this path works; the reason field carries the thrown error text.`,
  },

  "sso:statement_store_request": {
    title: "Statement-store request",
    body: `The Rust core sent a statement-store JSON-RPC request through the host chain transport. Request ids ending in \`:query:N\` are snapshot polling probes; \`:unsubscribe\` ids close live or query subscriptions.`,
  },

  "sso:statement_store_response": {
    title: "Statement-store response",
    body: `The statement-store transport returned a response or subscription page to the Rust core. The payload classifies live subscribe acknowledgements, snapshot query pages, unsubscribe acknowledgements, errors, and statement counts when available.`,
  },

  "sso:session_established": {
    title: "SSO session established",
    body: `Pairing or session restore succeeded. The Rust core has persisted the session and emitted session UI state so the topbar can show the connected account/username.`,
  },

  "sso:pairing_failed": {
    title: "SSO pairing failed",
    body: `The SSO flow ended without a connected session. This may be a user cancellation, mobile rejection, expired pairing statement, statement-store failure, or worker/core fault; inspect the preceding events in the same flow for the concrete cause.`,
  },

  // failover

  "failover:chain_backend": {
    title: "Chain backend failover",
    body: `The user clicked the "try the other backend" button after a resolution failure. The host persists the new backend selection to localStorage and reloads the tab. On the next boot, \`boot:started\` will show the new backend and resolution will run against it.

Tiered failover order: any smoldot variant → RPC; RPC → smoldot-shared-worker. The \`reason\` field captures the preceding error message so you can see *why* the failover was offered.`,
  },

  // main-thread monitor

  "main:stall_detected": {
    title: "Main-thread stall",
    body: `The host's event loop was blocked for more than ~200ms of wall-clock time. While the main thread is blocked the browser cannot:

• deliver queued \`window.postMessage\` events to the host's bridge listener — so any inbound \`host_handshake_request\` piles up on the event queue
• run the \`.then()\` microtask that would post the \`host_handshake_response\` back to the product
• paint, respond to input, or run any other timer

This is the most common cause of the "product is retrying handshake 300 times and the host is silent" window. Typical culprits: synchronous WASM compilation (smoldot / verifiablejs / codecs), service-worker / IndexedDB initialisation, or a heavy synchronous loop inside a product iframe's startup that the host ends up running as part of the same task.

If you see this event, the \`durationMs\` tells you exactly how long the loop was frozen — cross-reference with the timing of \`host_handshake_request\` messages to confirm which stall was the one that swallowed handshake delivery.`,
  },

  "main:heartbeat": {
    title: "Main-thread heartbeat",
    body: `Periodic "host is alive" marker emitted every 2 seconds by the main-thread monitor. Gaps between heartbeats wider than that mean the event loop was blocked — look for a nearby \`main:stall_detected\` event for the exact duration.

These are intentionally chatty on purpose: they're the control signal against which stall gaps are interpreted. They stop once the bridge has exchanged traffic in both directions (we see \`bridge:first_outbound\`) or after 2 minutes, whichever comes first.`,
  },

  "main:monitor_stopped": {
    title: "Main-thread monitor stopped",
    body: `The main-thread monitor has stopped emitting stalls and heartbeats. \`bridge_ready\` means the primary TrUAPI bridge finished its handshake and the monitor's reason-to-exist has been met. \`max_duration\` means the monitor hit its 2-minute safety cap without ever seeing \`bridge:first_outbound\` — usually a sign that the bridge never completed at all.`,
  },

  "sandbox:started": {
    title: "Sandbox boot started",
    body: `The sandbox iframe at \`<label>.app.dot.li\` has just started executing its own \`main()\`. It reads the curated URL params (resolved CID, content backend, chain backend, skip flags) from the host contract, and begins the "fetch the archive, then render it" pipeline.

Everything that happens from here until \`sandbox:document_written\` runs in the **sandbox origin**, not the host. During this window the host has already set \`iframe.src\` and is sending \`host_handshake_request\` on the bridge, but the product itself won't exist inside the sandbox iframe until \`document.write\` runs at the end of this flow. That's why you can see a long silent gap in the host's bridge swimlane: there is nothing to respond because the product isn't loaded yet.`,
  },

  "sandbox:sw_register_begin": {
    title: "Service worker registration",
    body: `The sandbox is registering its per-origin service worker. The SW is what intercepts sub-resource requests (CSS, JS, fonts, images) from the dApp after \`document.write\` — without it, those requests would fall through to the origin server and break the offline-capable "serve from bulletin chain archive" model.

\`waitForFreshController=true\` only happens on the \`fullReset=1\` boot path: after the host's settings popover nukes sandbox state, the existing \`navigator.serviceWorker.controller\` still points at the SW we just unregistered, so we have to wait for a \`controllerchange\` event to guarantee the new install has taken over.`,
  },

  "sandbox:sw_ready": {
    title: "Service worker ready",
    body: `The sandbox SW is active and controlling the page. \`durationMs\` is wall-clock from \`sw_register_begin\`; large values (multiple seconds) usually mean the browser had to install a brand-new worker on a cold cache, or the \`waitForFreshController\` branch was in play.`,
  },

  "sandbox:cache_checked": {
    title: "Service worker archive cache lookup",
    body: `The sandbox asked its SW whether it already has the packed archive for this \`(cid, contentBackend)\` pair in IndexedDB. Cache hits are nearly instant and skip the rest of the fetch pipeline — straight to \`document_written\`.

Cache misses are what drive the long window. The next event is \`sandbox:fetch_begin\` and then either \`helia_ready\` + a slow P2P download (often tens of seconds, peers permitting) or a gateway fetch.`,
  },

  "sandbox:fetch_begin": {
    title: "Archive fetch started",
    body: `Cache miss — the sandbox now has to pull the archive from the bulletin chain. The chosen \`contentBackend\` picks the transport:

• \`p2p-helia\` — load Helia/libp2p, open bitswap sessions to peers, request the CID, assemble chunks. Bandwidth-limited, peer-discovery-limited, and the single biggest source of "the host is silent for 15 seconds" symptoms — Helia can take many seconds to connect to its first useful peer.
• \`ipfs-gateway\` — plain HTTPS fetch from the configured IPFS gateway. Much faster but requires a trusted centralised endpoint.

\`fetch_complete\` closes this stage. The delta between these two events is the main fetch cost.`,
  },

  "sandbox:helia_ready": {
    title: "Helia P2P client ready",
    body: `Helia has finished its startup dance: libp2p transports are up, peer discovery has run, bitswap is wired into block storage. \`durationMs\` captures this initialisation cost. Anything significantly above a second here means P2P is slow to bootstrap in this environment — a hint that the actual \`fetchArchive\` call will also be slow.`,
  },

  "sandbox:status": {
    title: "Sandbox progress update",
    body: `Mirrors the human-readable status string the sandbox is showing in its own loading overlay ("Connecting to peers...", "Fetching via IPFS gateway...", etc.). These are the same messages dispatched via \`dotli:loading-status\` to the host's overlay — they're forwarded here so the system swimlane tells the same story the user sees.`,
  },

  "sandbox:fetch_complete": {
    title: "Archive fetch complete",
    body: `The archive is now available in memory. \`kind=archive\` means we got a multi-file bundle; \`kind=single\` means a single file (typically an encrypted single-file archive, or a non-standard upload). \`durationMs\` is the wall-clock cost of the fetch alone — cache lookup and SW-register time are **not** included.`,
  },

  "sandbox:decrypt_started": {
    title: "Encrypted archive — prompting for password",
    body: `The fetched payload has the encrypted-archive magic header. The sandbox has already told the host to dismiss its loading overlay and is now displaying the password prompt inside the sandbox iframe. This event starts the clock on any user-driven delay — if the user takes two minutes to type their password, that lands here.`,
  },

  "sandbox:decrypt_complete": {
    title: "Archive decrypted",
    body: `The password was correct; the ciphertext was successfully decoded and parsed into archive files. The rest of the pipeline continues as if the original fetch had returned a plain archive.`,
  },

  "sandbox:archive_stored": {
    title: "Archive staged in service worker",
    body: `The sandbox has packed the archive into a single \`Uint8Array\` + an index map, and posted it to the SW via \`postMessage({ type: "SET_ARCHIVE", ... })\`. The SW writes it into IndexedDB and acknowledges with \`ARCHIVE_READY\`. From now on, **all** sub-resource requests the dApp makes (CSS, JS, fonts) are served by this SW out of IDB instead of hitting the network.

This **must** complete before \`document.write\` for multi-file archives — otherwise the first CSS/JS request would race the SW install and miss.`,
  },

  "sandbox:document_written": {
    title: "Sandbox ready — dApp HTML written",
    body: `The sandbox has just called \`document.open()\` + \`document.write(html)\` + \`document.close()\`, replacing its own document with the dApp's \`index.html\`. From this moment the dApp's inline scripts start parsing, its bundled JS loads (served by the SW from the staged archive), and eventually the dApp instantiates its own TrUAPI transport and starts answering the host's handshake loop.

**This event is the key anchor for the "host sends 300 handshake requests" window.** The gap between the host's \`bridge:setup_ready\` and \`sandbox:document_written\` is exactly the window during which the product cannot yet respond to anything. \`totalMs\` is wall-clock from sandbox \`main()\` to this point.`,
  },

  "sandbox:failed": {
    title: "Sandbox boot failed",
    body: `Something in the fetch / decrypt / store pipeline threw. The sandbox has captured the exception to Sentry with the relevant \`dependency\` tag (\`ipfs-gateway\` / \`helia-bulletin\` / \`unknown\`) and rendered its error UI with a retry button. \`reason\` is the error message from whichever stage threw.`,
  },
};

/**
 * Look up the long-form explanation for a system event. Returns
 * `undefined` for any key that's not registered. Callers should
 * fall back to the summary line plus raw payload.
 */
export function getSystemExplanation(
  layer: string,
  event: string,
): SystemExplanation | undefined {
  return EXPLANATIONS[`${layer}:${event}`];
}
