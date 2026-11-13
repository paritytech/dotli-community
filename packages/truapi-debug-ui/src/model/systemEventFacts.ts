// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the panel knows about each host event, one row per member of the debug event union.

import { getSystemEventKey, type SystemEventKey, type SystemEventPair } from './getSystemEventKey.js';

/** The "What is this?" text of a host event. */
export type SystemExplanation = {
  title: string;
  /** Line breaks are preserved. Aim for 3 to 6 sentences on the phase, its triggers and what it unblocks. */
  body: string;
};

/** What the panel knows about one host event. */
export type SystemEventFacts = {
  explanation: SystemExplanation;
  /** Whether the event closes its flow, so the flow's timeline box stops pending. */
  endsFlow: boolean;
};

/** One row per host event, keyed by `layer:event`. */
const SYSTEM_EVENT_FACTS = {
  'boot:started': {
    explanation: {
      title: 'Host boot started',
      body: `The host application has begun executing \`main()\`. At this point the browser URL has not been parsed yet, the topbar is not mounted, and no network requests have gone out, but the chain backend and cache settings have already been read.

This is the very first application-level event you'll see in a tab. Everything downstream (resolver, render, bridge, product boot) follows from here, and every boot-layer event in this group shares the same \`flowId\`.`,
    },
    endsFlow: false,
  },

  'boot:protocol_warmup_started': {
    explanation: {
      title: 'Protocol iframe warmup started',
      body: `The hidden protocol iframe at \`dot.li/p/\` is being pre-warmed so it can service chain calls the instant a sandboxed product needs one. The backend decides the plumbing inside that iframe: \`smoldot-shared-worker\` (or \`shared-worker\` in an older archive) shares a smoldot instance with other tabs via a SharedWorker, \`smoldot-direct\` (\`direct\`) starts smoldot on the iframe's own main thread, and \`rpc-gateway\` (\`rpc\`) bypasses smoldot and connects to a WebSocket JSON-RPC endpoint.

Warmup happens in the background and is non-blocking. If a product calls chain services before warmup finishes, the protocol iframe queues the call and drains it once ready.`,
    },
    endsFlow: false,
  },

  'boot:topbar_ready': {
    explanation: {
      title: 'Top bar UI initialised',
      body: `The DOM for the top bar (logo, URL pill, auth/theme/mode buttons) has been wired. The auth module itself is not loaded yet. It's lazy-imported on first interaction, so a pairing flow only pulls in the SDK when the user actually clicks the sign-in button.`,
    },
    endsFlow: false,
  },

  'boot:url_parsed': {
    explanation: {
      title: 'URL inspected',
      body: `The current browser URL has been classified into one of three outcomes:

• \`label\` set: a product subdomain (e.g. \`hackme3.localhost\` or \`hackme3.dot.li\`) that will be resolved next.
• \`localhostHost\` set: a \`/localhost:PORT\` path, and the host will proxy directly to that dev server without resolving any dotNS name.
• Both null: the host URL itself (no subdomain), so the landing page is shown.

\`deepPath\` captures any path / search / hash fragment that will be forwarded into the product iframe after resolution.`,
    },
    endsFlow: false,
  },

  'boot:cid_cache_checked': {
    explanation: {
      title: 'CID cache lookup',
      body: `Checked the persistent CID cache (the host's CID cache, kept in IndexedDB) for a previously resolved \`label\` to \`cid\` mapping. A hit triggers the **fast path**: skip resolution entirely, render the cached CID, save ~1–5 seconds of boot time. A miss triggers the **slow path**: run the full resolver against the chosen chain backend.

The cache is populated at the end of each successful slow-path resolution (\`resolve:completed\`) unless the user has explicitly disabled caching in settings.`,
    },
    endsFlow: false,
  },

  'boot:block_cache': {
    explanation: {
      title: 'Host block cache',
      body: `How the host answered the sandbox's bitswap requests for this load. The host relays every block the sandbox asks for and keeps it in its own block cache in IndexedDB, hash-checked against its CID. \`hits\` came from there, \`misses\` went to the protocol iframe's light client. A load with no misses reads as an archive cache hit.

The sandbox cannot keep content itself: its iframe is credentialless, so its storage is dropped on every reload. In \`rpc-gateway\` mode the sandbox fetches from a gateway directly and this event does not appear.`,
    },
    endsFlow: false,
  },

  'boot:landing_page_shown': {
    explanation: {
      title: 'Landing page rendered',
      body: `The host URL had no product subdomain to resolve, so the landing page island rendered the marketing landing page and \`main()\` returned. Boot ends here. No product iframe, no bridge, no TrUAPI traffic.`,
    },
    endsFlow: true,
  },

  'boot:ready': {
    explanation: {
      title: 'Host boot complete',
      body: `The host has finished bringing up everything it needs for this tab. \`totalMs\` is wall-clock from the page load to this moment. The \`path\` field distinguishes how the tab got here:

• \`fast\`: CID cache hit, went straight to rendering.
• \`slow\`: full resolution ran against smoldot or the RPC gateway.
• \`localhost\`: localhost proxy path (developer workflow).

After this event, the TrUAPI bus starts producing traffic and the product is driving the timeline.`,
    },
    endsFlow: true,
  },

  'boot:failed': {
    explanation: {
      title: 'Host boot failed',
      body: `Boot hit an unrecoverable error before the product could render. The user sees an error card with a "try the other backend" button. Clicking that button fires a \`failover:chain_backend\` event and reloads.

\`dependency\` identifies which subsystem failed: \`smoldot\` for light-client issues (bootnode connectivity, chain sync timeout, panics) or \`asset-hub-rpc\` for RPC endpoint failures (DNS, 502, read timeout).`,
    },
    endsFlow: true,
  },

  'resolve:started': {
    explanation: {
      title: 'Name resolution started',
      body: `Beginning to resolve \`<label>.<tld>\` to its content CID. Two code paths exist:

• \`smoldot\`: runs a local WASM light client in the protocol iframe, syncs Asset Hub Paseo trustlessly, reads the \`dotns\` Solidity contract's ContentHash storage slot directly, and returns the decoded CID. Takes seconds to a minute on cold start.
• \`rpc-gateway\`: opens a WebSocket to a trusted RPC endpoint and issues a \`state_getStorage\` call against the same slot. Sub-second but relies on the gateway's honesty.`,
    },
    endsFlow: false,
  },

  'resolve:phase': {
    explanation: {
      title: 'Resolver progress',
      body: `A phase the resolver reported while it read the name: \`asset-hub-connecting\`, \`asset-hub-syncing\` and \`asset-hub-ready\` while its Asset Hub client is built, then \`resolving-content\`.

On the smoldot backends these phases drive the loading UI's phase bar. They ship to this panel so you can see exactly where a slow resolution is stuck.`,
    },
    endsFlow: false,
  },

  'resolve:storage_read': {
    explanation: {
      title: 'Storage read against dotns',
      body: `The resolver has read the \`dotns.ContentHash(namehash(label))\` Solidity storage slot on Asset Hub Paseo. The returned bytes are then decoded as an EIP-1577 IPFS contenthash (\`0xe3 01 70 12 20 …\`) to yield the raw CID hex.

\`bytes\` is the raw byte length returned. \`durationMs\` is the wall-clock for the storage read (excludes prior chain sync time).`,
    },
    endsFlow: false,
  },

  'resolve:completed': {
    explanation: {
      title: 'Name resolution complete',
      body: `Resolution succeeded. Two outcomes:

• \`cid\` is a string: the label points to a published CID. The host will render the product from \`<cid>.app.dot.li\` next.
• \`cid === null\`: the label exists on the network but has no ContentHash set. The owner needs to submit a preimage on Bulletin Chain and update the contract before anyone can load this domain.

\`durationMs\` is the full resolver time, from \`resolve:started\` to this event.`,
    },
    endsFlow: true,
  },

  'resolve:failed': {
    explanation: {
      title: 'Name resolution failed',
      body: `Resolution raised an exception. Common causes by source:

• \`smoldot\`: bootnode handshake failure, chain-sync timeout, smoldot panic, asset-hub unavailable.
• \`rpc-gateway\`: DNS failure, TLS handshake error, WebSocket closed before response, endpoint returned an error code, or the storage decoder rejected the response.

The host catches this and emits a \`boot:failed\` event (or a user-facing error with a failover button).`,
    },
    endsFlow: true,
  },

  'render:iframe_begin': {
    explanation: {
      title: 'Product iframe creation starting',
      body: `The host is about to insert an \`<iframe>\` into the DOM for the product. Two modes:

• \`iframe\`: plain embed of the URL directly (localhost dev-server proxy).
• \`subdomain\`: the full sandboxed flow. The iframe points at \`<label>.app.dot.li\` and the sandbox origin is responsible for fetching the CID's content, decompressing the archive, and rendering the product into its own nested iframe. The host stays the cross-origin bridge.

The iframe's \`sandbox\` and \`allow\` attributes are configured here based on the label's per-product permissions.`,
    },
    endsFlow: false,
  },

  'render:iframe_ready': {
    explanation: {
      title: 'Product iframe ready',
      body: `The iframe element is in the DOM and has started navigating to its URL. The product itself has not executed yet. That happens asynchronously as the browser loads the iframe content. Next up is the TrUAPI bridge setup, which runs in parallel.`,
    },
    endsFlow: true,
  },

  'bridge:setup_begin': {
    explanation: {
      title: 'TrUAPI bridge wiring',
      body: `Starting to wire the Rust-backed TrUAPI bridge between the host and the product iframe. This bridge carries **all** TrUAPI traffic: account derivation, transaction signing, chain connections, scoped localStorage, statement-store subscriptions, preimage submission, permissions prompts, push notifications.`,
    },
    endsFlow: false,
  },

  'bridge:setup_ready': {
    explanation: {
      title: 'TrUAPI bridge ready',
      body: `The primary bridge is live. From this moment on, every TrUAPI message exchanged with the product fires on the TrUAPI hook and appears in this panel's TrUAPI swimlane(s).

When the product opens a chain connection, the host serves it from smoldot or an RPC endpoint. When the product follows a chain's head (\`chainHead.follow\`), a rail lights up in that chain's swimlane.

**\`setup_ready\` only means the host is _listening_**, not that traffic has started. The next few events (\`iframe_load\`, \`first_inbound\`, \`first_outbound\`) anchor the window during which the product iframe is still loading and the handshake retry loop is firing without a response yet.`,
    },
    endsFlow: false,
  },

  'bridge:iframe_load': {
    explanation: {
      title: 'Product iframe loaded',
      body: `The browser has fired the product iframe's \`load\` event. For the \`iframe\` mode that means the dApp's own HTML has finished loading. For the \`subdomain\` mode it's the sandbox shell at \`<label>.app.dot.li\` that's loaded, while the inner dApp iframe is still being mounted and bootstrapped by the sandbox.

This is a common culprit for the gap between \`setup_ready\` and the first \`host_handshake_response\`: if the iframe takes many seconds to load (cold IPFS gateway, slow archive fetch), the product can't post anything to the host yet, so the host sits there with nothing to reply to.`,
    },
    endsFlow: false,
  },

  'bridge:first_inbound': {
    explanation: {
      title: 'First inbound bridge message',
      body: `The host's bridge provider has just delivered its first \`postMessage\` from the product iframe. Typically this is a \`host_handshake_request\`, but it may be the Nth retry if the product has been re-trying every 50ms while the host was still wiring up.

Gaps between \`setup_ready\` and \`first_inbound\` mean the product iframe wasn't talking yet. Either its JS hadn't started executing, or it was still initialising its own transport/sandbox relay before it could post anything.`,
    },
    endsFlow: false,
  },

  'bridge:first_outbound': {
    explanation: {
      title: 'First outbound bridge message',
      body: `The host has just posted its first TrUAPI message **to** the product iframe. For the \`host_handshake_request\` loop, this is the handshake response and effectively "closes" the bridge flow. From here on, normal request/response traffic flows both directions.

Gaps between \`first_inbound\` and \`first_outbound\` imply a host-side problem (the handler wasn't registered, or the main thread was blocked). Under normal conditions these two events land in the same millisecond.`,
    },
    endsFlow: true,
  },

  'failover:chain_backend': {
    explanation: {
      title: 'Chain backend failover',
      body: `The user clicked the "try the other backend" button after a resolution failure. The host persists the new backend selection to localStorage and reloads the tab. On the next boot, \`boot:started\` will show the new backend and resolution will run against it.

Tiered failover order: any smoldot variant fails over to RPC, and RPC fails over to smoldot-shared-worker. The \`reason\` field captures the preceding error message so you can see *why* the failover was offered.`,
    },
    endsFlow: false,
  },

  'main:stall_detected': {
    explanation: {
      title: 'Main-thread stall',
      body: `The host's event loop was blocked for more than ~200ms of wall-clock time. While the main thread is blocked the browser cannot:

• deliver queued \`window.postMessage\` events to the host's bridge listener, so any inbound \`host_handshake_request\` piles up on the event queue
• run the \`.then()\` microtask that would post the \`host_handshake_response\` back to the product
• paint, respond to input, or run any other timer

This is the most common cause of the "product is retrying handshake 300 times and the host is silent" window. Typical culprits: synchronous WASM compilation (smoldot / verifiablejs / codecs), service-worker / IndexedDB initialisation, or a heavy synchronous loop inside a product iframe's startup that the host ends up running as part of the same task.

If you see this event, the \`durationMs\` tells you exactly how long the loop was frozen. Cross-reference with the timing of \`host_handshake_request\` messages to confirm which stall was the one that swallowed handshake delivery.`,
    },
    endsFlow: false,
  },

  'main:heartbeat': {
    explanation: {
      title: 'Main-thread heartbeat',
      body: `Periodic "host is alive" marker emitted every 2 seconds by the main-thread monitor. Gaps between heartbeats wider than that mean the event loop was blocked. Look for a nearby \`main:stall_detected\` event for the exact duration.

These are intentionally chatty on purpose: they're the control signal against which stall gaps are interpreted. They stop once the bridge has exchanged traffic in both directions (we see \`bridge:first_outbound\`) or after 2 minutes, whichever comes first.`,
    },
    endsFlow: false,
  },

  'main:monitor_stopped': {
    explanation: {
      title: 'Main-thread monitor stopped',
      body: `The main-thread monitor has stopped emitting stalls and heartbeats. \`bridge_ready\` means the primary TrUAPI bridge finished its handshake and the monitor's reason-to-exist has been met. \`max_duration\` means the monitor hit its 2-minute safety cap without ever seeing \`bridge:first_outbound\`, usually a sign that the bridge never completed at all.`,
    },
    endsFlow: true,
  },

  'sandbox:started': {
    explanation: {
      title: 'Sandbox boot started',
      body: `The sandbox iframe at \`<label>.app.dot.li\` has just started executing its own \`main()\`. It reads the curated URL params (resolved CID, content backend, chain backend, skip flags) from the host contract, and begins the "fetch the archive, then render it" pipeline.

Everything that happens from here until \`sandbox:document_written\` runs in the **sandbox origin**, not the host. During this window the host has already set \`iframe.src\` and is sending \`host_handshake_request\` on the bridge, but the product itself won't exist inside the sandbox iframe until \`document.write\` runs at the end of this flow. That's why you can see a long silent gap in the host's bridge swimlane: there is nothing to respond because the product isn't loaded yet.`,
    },
    endsFlow: false,
  },

  'sandbox:sw_register_begin': {
    explanation: {
      title: 'Service worker registration',
      body: `The sandbox is registering its per-origin service worker. The SW is what intercepts sub-resource requests (CSS, JS, fonts, images) from the dApp after \`document.write\`. Without it, those requests would fall through to the origin server and break the offline-capable "serve from bulletin chain archive" model.

\`waitForFreshController=true\` only happens on the \`fullReset=1\` boot path. After the host's settings popover wipes sandbox state, the existing \`navigator.serviceWorker.controller\` still points at the SW the reset just unregistered, so the sandbox waits for a \`controllerchange\` event before it relies on the new install. When the browser kept the worker that controls the page, with nothing installing or waiting, no \`controllerchange\` can come, so it goes on at once.`,
    },
    endsFlow: false,
  },

  'sandbox:sw_ready': {
    explanation: {
      title: 'Service worker ready',
      body: `The sandbox SW is active and controlling the page. \`durationMs\` is wall-clock from \`sw_register_begin\`. Large values (multiple seconds) usually mean the browser had to install a brand-new worker on a cold cache, or the \`waitForFreshController\` branch was in play.`,
    },
    endsFlow: false,
  },

  'sandbox:fetch_begin': {
    explanation: {
      title: 'Archive fetch started',
      body: `The sandbox pulls the archive. Blocks the host already holds come from its block cache, the rest from the bulletin chain. The chosen \`contentBackend\` picks the transport:

• \`p2p-helia\`: load Helia/libp2p, open bitswap sessions to peers, request the CID, assemble chunks. Bandwidth-limited, peer-discovery-limited, and the single biggest source of "the host is silent for 15 seconds" symptoms. Helia can take many seconds to connect to its first useful peer.
• \`ipfs-gateway\`: plain HTTPS fetch from the configured IPFS gateway. Much faster but requires a trusted centralised endpoint.

\`fetch_complete\` closes this stage. The delta between these two events is the main fetch cost.`,
    },
    endsFlow: false,
  },

  'sandbox:helia_ready': {
    explanation: {
      title: 'Helia P2P client ready',
      body: `Helia has finished its startup dance: libp2p transports are up, peer discovery has run, bitswap is wired into block storage. \`durationMs\` captures this initialisation cost. Anything significantly above a second here means P2P is slow to bootstrap in this environment, a hint that the actual \`fetchArchive\` call will also be slow.`,
    },
    endsFlow: false,
  },

  'sandbox:status': {
    explanation: {
      title: 'Sandbox progress update',
      body: `Mirrors the human-readable status string the sandbox is showing in its own loading overlay ("Connecting to peers...", "Fetching via IPFS gateway...", etc.). These are the same messages dispatched via \`dotli:loading-status\` to the host's overlay. They're forwarded here so the system swimlane tells the same story the user sees.`,
    },
    endsFlow: false,
  },

  'sandbox:fetch_complete': {
    explanation: {
      title: 'Archive fetch complete',
      body: `The archive is now available in memory. \`kind=archive\` means we got a multi-file bundle. \`kind=single\` means a single file (typically an encrypted single-file archive, or a non-standard upload). \`durationMs\` is the wall-clock cost of the fetch alone. Cache lookup and SW-register time are **not** included.`,
    },
    endsFlow: false,
  },

  'sandbox:decrypt_started': {
    explanation: {
      title: 'Encrypted archive: prompting for password',
      body: `The fetched payload has the encrypted-archive magic header. The sandbox has already told the host to dismiss its loading overlay and is now displaying the password prompt inside the sandbox iframe. This event starts the clock on any user-driven delay. If the user takes two minutes to type their password, that lands here.`,
    },
    endsFlow: false,
  },

  'sandbox:decrypt_complete': {
    explanation: {
      title: 'Archive decrypted',
      body: `The password was correct. The ciphertext was successfully decoded and parsed into archive files. The rest of the pipeline continues as if the original fetch had returned a plain archive.`,
    },
    endsFlow: false,
  },

  'sandbox:archive_stored': {
    explanation: {
      title: 'Archive staged in service worker',
      body: `The sandbox has packed the archive into a single \`Uint8Array\` + an index map, and posted it to the SW via \`postMessage({ type: "SET_ARCHIVE", ... })\`. The SW keeps it in memory and acknowledges with \`ARCHIVE_READY\`. From now on, **all** sub-resource requests the dApp makes (CSS, JS, fonts) are served by this SW out of that in-memory archive instead of hitting the network.

This **must** complete before \`document.write\` for multi-file archives. Otherwise the first CSS/JS request would race the SW install and miss.`,
    },
    endsFlow: false,
  },

  'sandbox:document_written': {
    explanation: {
      title: 'Sandbox ready: dApp HTML written',
      body: `The sandbox has just called \`document.open()\` + \`document.write(html)\` + \`document.close()\`, replacing its own document with the dApp's \`index.html\`. From this moment the dApp's inline scripts start parsing, its bundled JS loads (served by the SW from the staged archive), and eventually the dApp instantiates its own TrUAPI transport and starts answering the host's handshake loop.

**This event is the key anchor for the "host sends 300 handshake requests" window.** The gap between the host's \`bridge:setup_ready\` and \`sandbox:document_written\` is exactly the window during which the product cannot yet respond to anything. \`totalMs\` is wall-clock from sandbox \`main()\` to this point.`,
    },
    endsFlow: true,
  },

  'chain:phase': {
    explanation: {
      title: 'A chain changed lifecycle phase',
      body: `One of the light client's chains moved to a new phase. These are derived from smoldot's \`lifecycle_unstable_follow\` stream, which reports a phase, a live peer count and a health verdict, and are the same milestones the loading screen advances on:

• \`connecting\`: the chain is dialling bootnodes and has not yet found a peer to sync from.
• \`syncing\`: peers are found and the chain is warping or catching up. \`warpAt\` and \`warpTarget\` bound the distance when a relay has real ground to cover.
• \`ready\`: the first finalized block landed, so storage can be read.
• \`stalled\`: the watchdog fired. \`reason\` is smoldot's own wording.

Only smoldot emits these. An \`rpc-gateway\` load runs no light client and so produces none. A phase is emitted only when it changes, so two consecutive events bound the interval the chain spent in the earlier one. That is exactly what the Resolution view draws.`,
    },
    endsFlow: false,
  },

  'chain:dbcache': {
    explanation: {
      title: 'Light-client warm start',
      body: `Whether the light client could resume this chain from the state it stored on an earlier visit. \`hit\` means it loaded the saved database and syncs on from there. \`miss\` means it starts from the chain spec's checkpoint, which is slower but just as correct. A stored state that fails to load counts as a miss.

Each chain reports once per page and the first answer wins, so a chain that connects twice reports only its first load. The Resolution view shows it on the chain's row. Only smoldot emits this, so an \`rpc-gateway\` load has none.`,
    },
    endsFlow: false,
  },

  'chain:peers': {
    explanation: {
      title: 'Light-client peer count',
      body: `How many peers one of the light client's chains holds, emitted each time the count changes. The count moves on its own schedule, apart from the chain's phase: a relay usually finds its peers after its last phase change.

A peer change never opens a phase block of its own. The Resolution view shows the best count seen while the chain was \`ready\`, or the highest count for a chain that never got there. Only smoldot emits this, so an \`rpc-gateway\` load has none.`,
    },
    endsFlow: false,
  },

  'chain:bytes': {
    explanation: {
      title: 'Light-client byte total',
      body: `The light client's cumulative received byte count, sampled on a tick. Cumulative rather than a rate, so the reader owns the averaging and a dropped sample only widens one window.

This counts chain traffic only. The archive download rides the same metered WebSockets in bulletin mode, so adding the sandbox's content bytes on top would double-count them.`,
    },
    endsFlow: false,
  },

  'sandbox:failed': {
    explanation: {
      title: 'Sandbox boot failed',
      body: `Something in the fetch / decrypt / store pipeline threw. The sandbox has captured the exception to Sentry with the relevant \`dependency\` tag (\`ipfs-gateway\` / \`helia-bulletin\` / \`unknown\`) and rendered its error UI with a retry button. \`reason\` is the error message from whichever stage threw.`,
    },
    endsFlow: true,
  },
} satisfies Record<SystemEventKey, SystemEventFacts>;

/** The facts of the host event `pair`, or undefined for an event the union does not name. Never throws. */
export function findSystemEventFacts(pair: SystemEventPair): SystemEventFacts | undefined {
  const key = getSystemEventKey(pair);
  // The key comes from the event at run time, so it can name an event this build's union lacks.
  if (!Object.hasOwn(SYSTEM_EVENT_FACTS, key)) {
    return undefined;
  }
  return SYSTEM_EVENT_FACTS[key];
}
