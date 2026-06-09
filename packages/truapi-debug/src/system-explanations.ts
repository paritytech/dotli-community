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
    body: `The iframe element is in the DOM and has started navigating to its URL. The product itself has not executed yet — that happens asynchronously as the browser loads the iframe content. Next up is the container bridge setup, which runs in parallel.`,
  },

  // bridge

  "bridge:setup_begin": {
    title: "TrUAPI bridge wiring",
    body: `Starting to wire the host-container postMessage bridge between the host and the product iframe. This bridge carries **all** TrUAPI traffic: account derivation, transaction signing, chain connections, scoped localStorage, statement-store subscriptions, preimage submission, permissions prompts, push notifications.

A nested-bridge detector is also installed here — it watches for \`postMessage\` from windows other than the primary iframe and dynamically creates additional bridges for dApp-in-dApp compositions.`,
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

  "bridge:nested_detected": {
    title: "Nested dApp detected",
    body: `A product running inside the main iframe is itself embedding another product via a nested iframe. Because \`postMessage\` to \`window.top\` lets any descendant iframe reach the host, the host runs a nested-bridge detector that recognises these new sources and spins up a dedicated TrUAPI container for each.

The inner product gets its own \`productId\` (\`parent:nested-N\`) and its own scoped storage prefix. Its traffic appears on the TrUAPI swimlane tagged with that productId.

There's a cap (\`MAX_NESTED_BRIDGES\` in config) to prevent runaway iframe trees from exhausting resources.`,
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

  // SSO (host-papp)

  "sso:pairing_started": {
    title: "Wallet pairing started",
    body: `\`createPappAdapter().sso.authenticate()\` was called, usually because the user clicked the sign-in button. A fresh sr25519 session account is being derived from a generated mnemonic (it exists only for this session — the real wallet stays on the mobile device).

\`metadata\` is the product-identity string the host passed when instantiating the PappAdapter; the mobile wallet will show this to the user as part of the consent screen.`,
  },

  "sso:deeplink_generated": {
    title: "QR code ready",
    body: `The host has built the handshake payload (session's sr25519 public key + encrypt public key + product metadata + host metadata) and base64-encoded it into a \`polkadotapp://pair?handshake=<hex>\` URL. This URL is rendered as a QR code in the browser.

The \`handshakeTopic\` is a derived statement-store topic. When the wallet scans the QR, decrypts the payload, and responds, it will post its response statement on this specific topic. The host has already subscribed to it by the time this event fires.`,
  },

  "sso:awaiting_response": {
    title: "Waiting for wallet scan",
    body: `The host is now blocked on the statement-store subscription, waiting for a matching response statement to land on the \`handshakeTopic\`. There's no timeout at this layer — the user might scan the QR in 5 seconds or walk away for 20 minutes.

If the user cancels the pairing dialog, an \`AbortError\` propagates and ends the flow with \`sso:pairing_failed\`.`,
  },

  "sso:response_received": {
    title: "Wallet response received",
    body: `The wallet posted its response statement on the handshake topic. The host has decrypted the response sensitive data (using the ECDH-derived shared secret), extracted the wallet's encrypt public key and account id, and instantiated a \`StoredUserSession\` bound to both parties.

The session isn't saved yet — that happens after attestation completes, so a failed attestation doesn't leave an orphaned session.`,
  },

  "sso:session_established": {
    title: "Session established",
    body: `The session has been persisted: session secrets in the \`UserSecretRepository\`, the session itself in the \`UserSessionRepository\`. The session manager's subscriber will pick up the new entry and emit \`session:opened\`.

After this event, the product can obtain signed payloads, request ring-VRF aliases, and receive disconnect signals via the session.`,
  },

  "sso:pairing_failed": {
    title: "Wallet pairing failed",
    body: `The pairing flow terminated without a session. Possible causes:

• User cancelled (AbortError): explicit cancel button on the QR modal.
• Subscription failure: statement-store could not deliver the response.
• Decrypt failure: response payload did not decrypt with the expected key — indicates a mismatched protocol version or a malicious response.
• Attestation parallel failure: the concurrent attestation flow failed, which also aborts pairing.

The UI shows the error message and resets so the user can try again.`,
  },

  // attestation (host-papp)

  "attestation:started": {
    title: "Guest identity attestation started",
    body: `Attestation runs in parallel with SSO pairing. Its job is to register the session's candidate account as a *lite person* on People chain, so the session has a verified guest identity rather than being fully anonymous.

The candidate is a session-scoped sr25519 account — different from the wallet's own identity. The verifier is the Sudo Alice key (in the current testnet setup; production will use a proper registrar).`,
  },

  "attestation:username_claimed": {
    title: "Username generated",
    body: `A random guest username of the form \`guest<4 letters>.<4-digit suffix>\` has been generated client-side. It's not yet on-chain — registration happens at \`person_registered\`. The prefix is what the session presents publicly; the numeric suffix is a disambiguator.`,
  },

  "attestation:allowance_granted": {
    title: "Verifier allowance granted",
    body: `A Sudo-wrapped \`PeopleLite.increase_attestation_allowance\` extrinsic has been submitted and reached best-block confirmation. This gives the verifier credits to vouch for up to N new guest identities (current setting: 10).

This step is idempotent — if the verifier already has sufficient allowance, the call is skipped and this event still fires.`,
  },

  "attestation:vrf_proof_generated": {
    title: "VRF ring-proof generated",
    body: `A ring-VRF proof of membership has been computed via \`verifiablejs\` for the candidate's entropy. This is the cryptographic evidence that the candidate is a legitimate member of the guest ring.

Ring-VRF is zero-knowledge: the proof does not reveal which ring member the candidate corresponds to — only that they are one of them.`,
  },

  "attestation:person_registered": {
    title: "Person registered on-chain",
    body: `The \`PeopleLite.attest\` extrinsic has been submitted (signed by the verifier) and landed at best-block or finalization. The candidate's identity is now live on People chain.

The call bundles the candidate signature, the ring-VRF key + proof, and a \`consumer_registration\` struct that records the username and identifier key. Any future interaction using this session's identity keys will be recognised on-chain.`,
  },

  "attestation:completed": {
    title: "Attestation complete",
    body: `All three on-chain steps (allowance grant, VRF proof, person register) succeeded. The guest identity is live. The parallel SSO pairing flow can now finalise into a saved session.`,
  },

  "attestation:failed": {
    title: "Attestation failed",
    body: `One of the attestation sub-steps threw. Most common causes:

• Allowance extrinsic reverted — verifier out of allowance and sudo-increase failed.
• VRF proof generation exception — verifiablejs WASM init failed or the entropy was malformed.
• \`PeopleLite.attest\` rejected — dispatch-error (e.g. duplicate username, invalid signature).

The parallel pairing flow is torn down too. No session is stored.`,
  },

  // session (host-papp)

  "session:opened": {
    title: "Session opened",
    body: `A \`UserSession\` object has been instantiated for a stored session (either a freshly paired one or one restored from storage at host boot). The session is now subscribed to its statement-store channel for peer-originated actions (signing requests, alias responses, disconnect signals).

The session persists across page reloads until explicitly terminated. Multiple sessions can be active simultaneously — each gets its own \`session:opened\` event with a unique \`sessionId\`.`,
  },

  "session:peer_action_received": {
    title: "Wallet-originated action arrived",
    body: `The wallet posted an action on the session's statement-store channel. \`actionKind\` identifies it: \`SignResponse\` (response to a signing request the host initiated), \`RingVrfAliasResponse\`, \`Disconnected\` (user chose to disconnect in the wallet UI), etc.

The host hasn't processed the action yet — the handler will run and emit either \`peer_action_processed\` or \`peer_action_failed\`. Already-processed messages are deduplicated by \`messageId\`.`,
  },

  "session:peer_action_processed": {
    title: "Peer action handled",
    body: `The session's action handler completed.

• \`processed=true\` — the handler recognised the action and acted on it (e.g. a \`Disconnected\` peer-action triggered session removal).
• \`processed=false\` — the handler didn't match or chose to ignore; the action was accepted but had no effect.`,
  },

  "session:peer_action_failed": {
    title: "Peer action handling failed",
    body: `The action handler threw. Common causes: decrypt failure on the statement data, response came in for a messageId the host doesn't remember, malformed payload. The error is logged; the session continues.`,
  },

  "session:host_action_sent": {
    title: "Host-originated action sent",
    body: `The host is initiating an action to the wallet. Kinds:

• \`SignPayload\` — the wallet needs to sign an extrinsic SignedPayload (a transaction the product wants to submit).
• \`SignRaw\` — the wallet needs to sign arbitrary bytes (common for off-chain auth, not transactions).
• \`RingVrfAliasRequest\` — the wallet should derive a product-scoped alias via ring-VRF.
• \`Disconnect\` — the host is tearing down the session and informing the wallet.

The action is encrypted and posted on the session's channel. The host is now waiting for a matching response statement.`,
  },

  "session:host_action_response_received": {
    title: "Wallet responded to host action",
    body: `The wallet posted its response on the session's channel and the host decrypted it.

• \`success=true\` — the wallet approved; the response carries the signature or alias (payload-dependent).
• \`success=false\` — the wallet declined or errored; the response carries a failure reason. The caller (product) will see an error.

Distinct from \`host_action_failed\`, which is a transport-level failure (no response at all).`,
  },

  "session:host_action_failed": {
    title: "Host action transport failure",
    body: `The statement-store request/await machinery errored before a response could arrive. Possible causes: the peer took too long and the host gave up, the session's channel was torn down mid-request, or the response decrypt failed (wrong key or corrupted payload).

Different from \`host_action_response_received\` with \`success=false\`, which is a business-level decline by the wallet.`,
  },

  "session:terminated": {
    title: "Session terminated",
    body: `A session has been removed from the repository. This happens on:

• Explicit host disconnect — \`sessionManager.disconnect(session)\`, typically from a log-out click.
• Explicit peer disconnect — the wallet posted a \`Disconnected\` peer-action (user logged out on their phone).
• Global clear — all sessions wiped (e.g. on a "full reset" flow).

After this event, no further peer-actions or host-actions are delivered on this \`sessionId\`.`,
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
