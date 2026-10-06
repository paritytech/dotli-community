> [!WARNING] The following is a prototype, reference implementation, and proof-of-concept. This open source code is
> provided for research, experimentation, and developer education only. This code has not been audited, is actively
> experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

<div align="center">

# dotli

[![Website](https://img.shields.io/badge/paseo.li-online-blue?style=flat-square)](https://paseo.li)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Polkadot](https://img.shields.io/badge/polkadot-ecosystem-E6007A?style=flat-square&logo=polkadot)](https://polkadot.com)

A decentralized web browser that runs in your browser. Visit any Polkadot application with fully trustless, client-side
resolution — no servers in the loop.

[Website](https://paseo.li) | [Report an Issue](https://github.com/paritytech/dotli-community/issues)

</div>

---

## How to access apps

dotli resolves apps by **subdomain** — the `.dot` name is the host:

| Format        | Example                            |
| ------------- | ---------------------------------- |
| **Subdomain** | `https://host-playground.paseo.li` |

### Landing page

When visiting the root (`paseo.li`), a landing page is shown with:

- A **search bar** where users type an app name (a `.dot` suffix label is shown next to the input) and navigate
- **Recently visited** apps shown as pill-shaped shortcuts (persisted in localStorage)
- A **login** button in the top-right corner

The topbar is hidden on the landing page and only appears when viewing an app.

## Architecture

dotli uses a **two-build, per-product subdomain architecture** that separates concerns between the host shell and the
app content layer:

```
name.paseo.li            Host build (topbar, dotns resolution, smoldot, bridge)
                          Resolves name -> CID, iframes name.app.paseo.li with the CID
                          threaded through the URL contract

name.app.paseo.li        App build (CID from URL contract, content fetch, render)
                          Reads CID from URL, fetches via bitswap/gateway, renders
```

| URL                            | Role         | What happens                                                                            |
| ------------------------------ | ------------ | --------------------------------------------------------------------------------------- |
| `host-playground.paseo.li`     | Host shell   | Resolves `host-playground` via dotns, iframes `host-playground.app.paseo.li?cid=bafy..` |
| `host-playground.app.paseo.li` | App content  | Reads CID from URL contract, fetches content, renders                                   |
| `paseo.li`                     | Landing page | Search bar, recent apps                                                                 |

Each product gets its own `<label>.app.paseo.li` origin, so versions of the same product share an origin while different
products stay isolated for SW/storage/security purposes.

The iframe bridge deduplicates TrUAPI readiness retries by the SDK's public `connectionId`. Replacing an already-adopted
port on a queued retry disconnects the product, so only a new connection identifier triggers reconnection. A genuine
document reload supplies a new identifier. The existing source-window and origin checks still apply; the identifier is
not an authority token.

### What it does

1. **Resolves** `.dot` names via an in-browser [smoldot](https://github.com/paritytech/smoldot) light client connected
   to Asset Hub Paseo, querying dotNS contracts.
2. **Fetches** content from the [Bulletin Chain](https://github.com/paritytech/polkadot-bulletin-chain) via smoldot
   `bitswap_v1_get` JSON-RPC or an IPFS gateway.
3. **Renders** the content in a sandboxed iframe with the Rust-backed TrUAPI bridge, so loaded SPAs can request
   accounts, sign transactions, connect to chains, and use scoped storage.
4. **Runs** verified framebuffer PolkaVM products by translating `app.polkavm` to WebAssembly at load time inside a
   worker, with a bounded interpreter fallback.

```
host-playground.paseo.li
    -> Host: smoldot resolves dotNS -> IPFS CID
    -> Host: iframes <label>.app.paseo.li with cid in URL contract
    -> App:  fetches content via smoldot bitswap_v1_get or IPFS gateway
    -> App:  renders dApp in sandboxed iframe with container bridge
```

Single-file apps are served as blob URLs. Multi-file SPAs (directories) are fetched as CAR archives, parsed, and served
through a Service Worker that acts as a virtual file system.

### What it doesn't do

- Production builds are **not** a wallet or key custodian. Per-app keys are derived on demand via HDKD soft derivation,
  and signing is delegated to the connected Polkadot App session. Debug builds also offer an explicitly experimental
  [test wallet](#experimental-test-wallet).
- It does **not** run its own RPC servers or backends. Chain access is through an in-browser smoldot light client, and
  dotNS records are read directly from the contract storage.
- It does **not** pin or host content. Content is fetched from the Bulletin Chain or an IPFS gateway and served locally
  per session.
- It is **not** a production-hardened product. Treat it as a reference blueprint (see [Security](#security)).

## How resolution works

1. Parse the label from the subdomain (`host-playground.paseo.li` -> `host-playground`)
2. Compute the ENS-style namehash (`node`) of the name — the resolver tries `app.<label>.dot` first and falls back to
   `<label>.dot`
3. Read the `contenthash` bytes for `node` directly from the dotNS ContentResolver contract storage
4. Decode the contenthash bytes to an IPFS CID (using `@ensdomains/content-hash`)
5. Create an iframe to `<label>.app.paseo.li?cid=<cid>` which fetches and renders the content

All chain access is read-only storage reads through the smoldot light client — no RPC server needed. (An optional
gateway backend reads the same storage over a public RPC node instead.)

Both resolution backends retry a stopped chain generation once at the resolver boundary, using a fresh client and the
remaining original sync budget. A second stop is returned to the caller; protocol callers do not add another retry.

The browser regression injects a stop into a real RPC storage read; replacing the whole resolver would bypass this
recovery boundary.

The host shares one replaying transport per chain through the chain pool and broker; request ids, subscription tokens,
and follow pins stay isolated between core consumers. RPC sockets reconnect and replay confirmed statement
subscriptions. Acknowledged modern and legacy transaction watches terminate when a socket disconnects rather than
resubmitting a transaction. The provider's heartbeat owns reconnection; there is no second health-request keepalive.
Smoldot terminal loss retires the pool entry, errors pending requests, stops follows, and ends subscriptions before
notifying each lease. The protocol iframe and SharedWorker use the same transport hooks while retaining their long-lived
chain pools. The temporary light-client submit fallback remains independent and uses trusted RPC only for the existing
dropped legacy-extrinsic case (see ADR 0002).

The native connection stays open across a halt: queued requests receive terminal errors, existing follows stop, and the
same core/client can take a fresh lease on its next request through the canonical backoff gate. A crashed SharedWorker
retires its URL generation under a shared-origin Web Lock before the iframe reports fatal. Tabs in the same storage
partition share the replacement generation; late callbacks cannot retire it. Recovery does not require closing other
tabs.

## How multi-file SPAs work

When a CID points to an IPFS directory (not a single file):

1. The gateway returns a CAR (Content-Addressable aRchive) containing all files
2. `archive.ts` parses the CAR using `@ipld/car` + `@ipld/dag-pb` + `ipfs-unixfs` to extract a file map
3. The file map is sent to the app Service Worker via `postMessage`
4. The iframe loads from `/dotli-app/index.html` — the SW intercepts all requests and serves files from the in-memory
   archive
5. Relative imports (`<script src="main.js">`, `<link href="styles.css">`) just work

## How PolkaVM apps work

An archive whose `manifest.json` declares `runtime.kind: "polkavm"` never executes package-owned HTML. The sandbox
instead creates a host-owned canvas, loads the verified `app.polkavm` and immutable package assets, and translates the
program to WebAssembly inside a worker. Keyboard, pointer, framebuffer, PCM-audio, asset, save, and UI integration
traffic stays on the bounded PolkaVM runtime ABI 1. Guest Host requests use the neutral
`host_frame_send`/`host_frame_poll` ABI; the browser worker exposes the same transport as
`host-frame-request`/`host-frame-response` messages.

Host-frame bytes use the canonical TrUAPI wire codec, currently version 3. Build guest clients against the SDK recorded
in `vendor/truapi-host.lock.json`; runtime ABI 1 compatibility alone does not imply TrUAPI wire compatibility.

On this branch, `vendor/truapi-host.lock.json` pins the canonical SDK and Wasm to `feat/media-on-jam-seity`, the native
merge of the Media layer into `feat/jam-peer-transport-on-seity`. JAM peer transport is execution-local in the sandbox.
Before dialing a network, it requests `JamPeers` permission through the product's authenticated port to the shared page
core. The host's Solid permission dialog shows the full genesis hash and offers **Allow once**, **Always allow**, and
**Deny**; dismissal saves no decision. Durable decisions are scoped to product and genesis, while a one-time grant lasts
only for that execution. This grants no account, signing, storage, or arbitrary web access.

The sandbox checks for the required browser WebTransport capability before requesting permission. If it is unavailable,
the host leaves the stored permission unchanged, shows the detected browser version and compatibility requirements, and
the app can continue with its verified snapshot. Supported versions are Chrome or Edge 100+, Firefox 125+, and
Safari/iOS 26.4+.

The canonical session uses WebTransport to validators, with at most eight connections, sixteen streams per connection,
and 1 MiB messages. Received data remains unverified until the guest checks it. The runtime menu's **Network access**
section lists this execution's grants. Network updates continue while its display/audio menu is paused. Stop,
replacement, and runtime failure close the session and refuse outstanding permission requests; a replacement guest
cannot consume old replies. Ordinary host frames retain their 1 MiB bound and still use the shared page core; only peer
frames use the larger bound needed for message framing. The session's ten-second dial deadline includes the permission
prompt: a late decision does not resurrect an expired dial, though a retry can use the remembered decision.

App manifest v2 uses runtime ABI 1 with framebuffer, Tri2D, WebGPU Raster, and bounded capability negotiation; TrUAPI,
MotionSample v1, text, IME, focus, and wheel input use the same pinned browser runtime as native Hosts. UI output v1
applies cursor and IME-agent state in the sandbox. Clipboard text and HTTP(S) navigation cross an origin-checked parent
channel; the Host consumes at most one command per trusted input while browser transient activation remains live, with a
five-second upper bound to accommodate cold guest execution. It does not grant the app iframe clipboard permission.
Guests request relative-pointer capture through the runtime; desktop Pointer Lock begins on the next primary click.

On coarse-pointer (touch) devices, a guest that declares keyboard and pointer input and requests capture gets host-owned
FPS controls instead of requiring Pointer Lock. The left stick sends WASD movement/strafe keys; the right stick
continuously sends relative look input. Buttons provide Fire (left mouse), Grapple (Q), Jump (Space), Reload (R),
Start/Continue (Enter), and Run (Shift). These are standard key/button mappings, not new guest actions or a new ABI;
their meaning remains guest-defined. Skyhook also uses R to restart.

Contacts are independent, so movement, aiming, and firing can overlap. Cancelling one contact releases only its input;
focus loss, backgrounding, resizing, and disabling controls release all held virtual input and stop aiming. Physical
keyboard/mouse input remains independent of virtual holds. The overlay respects safe-area insets and is absent on
desktop-only devices and apps that do not request capture; ordinary apps continue receiving raw multi-touch records.

Apps register file handlers at runtime through `host_file_register`; manifest declarations do not authorize file
delivery. The sandbox follows the current execution's `file-registrations` and exposes **Open file** and drag/drop only
when ready. Packaged content starts normally without selecting a file. A guest `file-input-request` opens the app menu;
the user clicks **Open file** to supply the browser activation required for the native picker. The host asks for
explicit consent and routes the file to that execution's current registration, not to another product or a stale
handler.

After file approval, a host-owned loading overlay names the selected file. Once delivery is ready, the paused menu
offers **Resume and load**; the overlay clears when the guest presents new content after delivery. Restoring an old
WebGPU/Tri2D surface on Resume does not finish loading. Guests that decode before switching levels must defer gameplay
frames during preparation. Delivery rejection clears the overlay and keeps the recovery menu available. This is an
activity indicator, not a percentage estimate of guest-side decoding.

Inline and relaunch handlers receive bounded bytes. Stream handlers receive the original browser `Blob`, without a
whole-file read or upload by the host; the runtime manages bounded reads and private OPFS caches. Cache creation and
cleanup errors are recoverable and reported separately from fatal runtime errors. Stopping cancels pending selection,
waits for the runtime's cleanup acknowledgement, and only then terminates its worker; an unresponsive worker is forcibly
terminated after one second with an explicit warning that cache cleanup could not be confirmed. Browser process death or
abrupt document destruction cannot guarantee a cleanup acknowledgement.

Only a runtime `file-input-delivery` with outcome `relaunch` authorizes restarting with its session-only mount. Retry
preserves that selection; **Return to launcher** restores the original package. Save storage remains isolated by product
origin and, for mounted/relaunch content, the file digest, so different cartridges do not share save data. Stream/inline
selection does not change the save namespace. Picker cancellation and released file streams do not cancel or invalidate
an unrelated camera request.

While a guest text field is active, native paste shortcuts (`Cmd+V`, `Ctrl+V`, `Ctrl+Shift+V`, or `Shift+Insert`, where
supported by the browser) deliver plain text through bounded text-input records. They do not also invoke the guest's
internal clipboard paste action. Copy shortcuts remain guest-defined and use the origin- and activation-checked
UI-output channel above.

The browser artifacts are byte-for-byte copies of the `@parity/polkavm-browser-runtime` package pinned in
`scripts/polkavm-runtime.lock.json`. The package already uses the `polkavm-` paths this Host serves, so synchronization
verifies and copies them without renaming. Wasm and worker URLs include their pinned asset SHA-256, preventing an old
force-cached Wasm binary from being reused with an updated worker. The translation cache identity is derived from the
same lockfile. Translated Wasm bytes are cached in product-origin IndexedDB by the SHA-256 of the PolkaVM program and
the pinned translator revision. The credentialless sandbox's translation cache and cartridge saves belong to the current
top-level document's ephemeral storage partition; they are not durable across host-page reloads. In-page restarts can
reuse the translation cache and the bounded compiled-module cache. WebAssembly compilation remains browser-owned. If
translation or Wasm compilation fails, the same worker retries through the bounded interpreter.

The current pin is the `0.3.2-rc.3` release candidate, including runtime-registered streamed file input, private caches,
and translated updates resumed across bounded gas slices; this update retains the separately pinned TrUAPI host SDK.
Synchronization verifies the package's complete checksum inventory, including its session API and type declarations, but
serves only the host's selected runtime artifacts. Preserve `LICENSE-MPL-2.0`, `THIRD_PARTY_NOTICES.md`, and
`THIRD_PARTY_LICENSES.txt` alongside those artifacts; the consolidated attribution bundle replaces the older standalone
PolkaVM license files.

The Doom performance gate measures presented frames over 30 seconds against the guest's 35-tic/second cadence, with one
frame of sampling-boundary tolerance. The displayed short-window FPS remains unrounded and is not the acceptance sample.
Update p95 must remain below 28.6ms; cold/warm first-frame limits remain 3,000/1,000ms, with audio and translation cache
checks unchanged. This replaces the instantaneous `FPS >= 35` gate explicitly; earlier failures remain recorded.

Runtime failures are reported from the sandbox to Sentry with the resolved CID, program SHA-256, pinned browser-runtime
revision, active backend, startup stage, graphics profile, and trap program counter when present. The existing
resolution ID correlates the failure with the host and protocol events for the same load; app bytes and imported file
contents are never attached.

## Caching and verification

dotli uses three cache layers:

1. **Installed executable cache** (host IndexedDB) — stores the contenthash and exact root/executable manifests
   together, keyed by network, modality, and label. The host revalidates the record before selecting the runtime; a
   changed contenthash never runs with the previous contenthash's manifest. Entries predating root-manifest storage
   resolve again. Unknown manifest versions, invalid records, and apps without their root manifest are rejected before
   content downloads; supported App v1 and web/PolkaVM App v2 retain their runtime-specific validation.
2. **Block cache** (host IndexedDB) — keeps the content blocks the host relays to the sandbox, hash-checked against
   their CIDs. The credentialless sandbox retains its archive in partitioned IndexedDB across service-worker restarts,
   but not across top-level host-page reloads.
3. **PolkaVM translation cache** (sandbox IndexedDB) — stores translated Wasm bytes keyed by translator version and
   program digest for the current top-level document's lifetime.

Warm visits reuse a validated installed executable and locally cached content blocks. The topbar shield shows how the
current page was loaded:

| Shield           | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| Green (Verified) | Checked by your in-browser light client (the default smoldot backend)         |
| Orange (Trusted) | Served by an external RPC provider or IPFS gateway, not light-client verified |

If a background re-resolution finds the on-chain CID has changed, dotli shows a **New version available** notification
with a **Reload** action rather than swapping content silently.

The host PWA caches its shell separately from the cross-origin sandbox. On a worker update, open host pages report their
sandbox-contract version. Matching hosts keep the normal update prompt. Legacy, incompatible, or nonresponsive hosts are
reloaded at the same URL after the new shell finishes installing, without clearing wallet/app storage or product caches.
This lets an already cached host recover even when it cannot understand the newer sandbox's update request; the
sandbox's strict contract validation remains unchanged. As with any host reload, in-memory app state and credentialless
iframe storage restart; persistent host storage is retained.

Astro builds the release-specific classic upgrade worker after its static pages and before Workbox emits `host-sw.js`.
Browser validation and Node-loaded build configuration share the version in
`packages/config/src/host-sandbox-version.ts`; the build does not import browser network configuration.

Failed host-worker update checks are handled and logged as warnings, leaving the active worker, current page, and
persistent storage intact. The existing 15-minute and visible-tab checks can retry later; failures do not start an
additional retry loop or bypass reload consent. A required sandbox-contract update remains pending after a failed check
and still activates automatically once a compatible replacement finishes installing.

## TrUAPI bridge

Loaded SPAs communicate with dotli through a postMessage-based protocol. The bridge exposes:

| Handler                        | What it does                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `accountGet`                   | Derives a per-app public key via HDKD soft derivation                                 |
| `getLegacyAccounts`            | Returns non-derived (imported) accounts — always empty on the web host                |
| `signPayload` / `signRaw`      | Shows signing modals and routes signing through the active session                    |
| `chainConnection`              | Returns an isolated broker connection over the selected chain backend                 |
| `localStorageRead/Write/Clear` | Scoped `localStorage` per `.dot` domain                                               |
| `navigateTo`                   | Moves the current tab to another dotNS product; external URLs open in a new tab       |
| `featureSupported`             | Reports whether a feature is supported (e.g. a chain's genesis hash)                  |
| `connectionStatus`             | Streams auth state changes to the SPA                                                 |
| `chat.*`                       | Product chat: rooms and messages persisted locally, rendered in the topbar chat panel |

### Permission decision ownership

Core-initiated permission callbacks return the user's decision without writing the grant. The canonical core commits
that decision against the permission revision it captured before prompting; an adapter-side write would invalidate the
pending request. Host-initiated mediated-device prompts still persist their own durable decisions.

After a committed permission change, the bridge matches the canonical product identity and refreshes the active iframe's
Permissions Policy. It replaces the iframe only if that policy changes. Notification approval therefore keeps the
requesting execution alive; grants that change iframe access reload it, and stale executions cannot trigger reloads.

### Ordinary notification activation

Ordinary notification clicks do not require background receiver enrollment or a relay. The host retains each click in
host-owned IndexedDB, scoped to the product execution, authenticated account, network and executable artifact. OS
notifications carry only an opaque token; the existing host service worker records activation before focusing or opening
the host entry page. It does not navigate the product's route.

The matching foreground product polls `notifications.activationEvents()` and receives up to 32 pending events in
`{ events }`. After handling an event, it calls `notifications.acknowledgeActivation({ sequence })`. Reads do not
consume events; acknowledgements are exact and idempotent. Account changes invalidate the live scope, and another
product, account, network or artifact cannot read or acknowledge the retained activation.

Direct-iframe products, including localhost previews, use the same permission and account gates. Because their mutable
URLs do not identify verified executable content, each execution receives a fresh artifact identity. Reloading or
replacing a direct iframe cannot inherit an earlier execution's notification activations.

Destinations may be local absolute paths or existing HTTP(S)/`polkadot:` deep links. They are returned unchanged as
opaque product data; neither toast nor service worker follows the supplied URL. Retention expires after seven days and
is bounded to 256 records; a full queue never evicts an unacknowledged clicked event to accept a new notification.
In-page toasts remain actionable when OS permission or service-worker notification delivery is unavailable. OS focus and
window opening remain browser-controlled. Native hosts need their own activation adapter; this browser change does not
supply one.

### Background receiving activation

Startup republication of unchanged, already-enabled watches in the current authorized receiver scope preserves its
revision, retained events, display receipts and transport synchronization state. A cold notification click therefore
survives product startup. Genuine watch changes still advance the revision and reject clicks from the previous policy.

### Product chat

Products that declare `includes.chat` in their `worker.<label>.<tld>` executable manifest get a Worker-kind TrUAPI
execution and a chat button in the topbar. The product drives the conversation over the core's chat surface
(`chat.create_room`, `chat.register_bot`, `chat.post_message`, `chat.list_subscribe`, `chat.action_subscribe`); the user
replies from the docked chat panel, and each reply reaches the product as a `MessagePosted` action. Rooms and messages
persist in IndexedDB on the product origin and never leave the device. The core denies chat calls without an active
session, so chat requires being logged in. The localhost debug paths enable chat unconditionally so local products can
be tested without publishing a manifest.

Custom messages (`ChatMessageContent::Custom`) render live: when a custom message cell scrolls into view, the panel asks
the product to draw it through the Renderer service (`renderer.render`, with a `ChatMessage` render context) and renders
the streamed tree with the host's Solid components (`packages/ui/src/components/chat/CustomMessage.tsx` and
`CustomNode.tsx`). The tree is a closed vocabulary of layouts and design tokens, so a product can never inject markup,
styles, or URLs. Button taps and text-field edits inside a rendered tree flow back on `renderer.action_subscribe`; taps
on `Actions`-content buttons flow back as `ActionTriggered` chat actions. Replacing a streamed tree aborts its image
loads and revokes its object URLs; scrolling a message out of view or closing the panel releases its render subscription
and tree resources.

### App iframe model

The host creates one TrUAPI bridge for the rendered product iframe. dApp-in-dApp iframes are opaque to the host and must
use the top-level product's shared Rust core/provider context rather than separate host-created bridges.

Product connections share one page core, including its authentication, session storage, and native Wallet owner. Each
connection has its own interactive callbacks and blocking-modal scope. Closing a connection, losing its port, or failing
provider creation disposes its active and queued consent immediately, even while a replacement connection keeps the core
alive. Late consent responses and auth changes from the retired connection cannot authorize or update the replacement.
Core retirement also disposes pending connection scopes before provider creation finishes; replacing an iframe does not
recreate the native Wallet or reset its signing watermark.

The app context uses `document.write()` to eliminate extra iframe nesting: when loaded inside a host iframe, the app
replaces its own document with the dApp content so the dApp occupies the iframe directly.

### Protected browser Media

The bridge installs `@parity/truapi-host/web`'s `createBrowserMediaBackend` for each cross-origin HTML and PolkaVM
product connection, App and Worker alike. The Media service (prototype wire trait 218) needs the matching vendored
client, host callbacks, worker bridge and WASM from the native Media layer; updating a single vendored file is unsafe.

A protected product iframe has no camera, microphone, display-capture, fullscreen or picture-in-picture permission and
no popups or top navigation; its other device grants still apply. Capture grants authorize the trusted host, not raw
iframe capture: a raw camera or microphone request fails with an error rather than a denial, so it never records a
durable device denial that would block host Media. Host video planes are siblings of the product inside an isolated
compositor that takes the frame's layout; neither product DOM/canvas readback nor the product's own RTC connections
reach host tracks, peers, SDP, ICE or decoded pictures. Host occlusion hides or clips the planes, scaled, rotated or
skewed layouts blank them, and the call, screen-picker, audio-resume and end-call controls stay above the product.

Calling consent shows the exact product, sr25519 account and network genesis. Each prompt is cancelled with its
operation, never reloads the product, and persists nothing in browser UI code: the core owns scoped authorization. The
permissions menu lists the Calling scopes the core used and revokes them; withdrawing Calling, microphone or camera
authority ends active calls. Runtime replacement, navigation, identity changes and teardown fence pending consent and
capture.

Core storage implements exact-byte compare-exchange. Browser slots serialize per physical slot on cross-document Web
Locks, the shared auth session on its protocol-origin slot lock, and test-wallet custody in the protocol frame's custody
lock. An explicit policy change queues its scoped notification with the successful commit; unanswered Ask initialization
stays silent. Cores sharing that storage refresh authorization through a host-private, acknowledged BroadcastChannel,
and the settings setter returns only after that fan-out. Without Web Locks, compare-exchange and unavailable
synchronization fail closed; plain slot reads, writes and clears continue.

Products needing legacy raw capture can select **Use legacy raw capture** in the permissions menu. This ends protected
calls and reloads into an execution where Media is unsupported and existing device grants govern raw capture. **Use
protected host Media** reloads back. The choice is execution-local, not a remembered consent. Same-origin frames never
advertise Media.

ICE is relay-only: the host Media backend gathers relay candidates alone, so calls need a TURN relay.
`VITE_MEDIA_ICE_SERVERS` is a build-time JSON `RTCIceServer[]` of credentialed `turn:`/`turns:` servers, e.g.
`[{"urls":["turns:turn.example:5349"],"username":"dotli","credential":"…"}]`. STUN entries, extra fields and missing
credentials are rejected; unset means calls cannot connect. Products never supply ICE settings. The Deploy workflow
mints 48-hour Cloudflare TURN credentials for each deploy (`scripts/mint-media-turn.ts`); they ship in the public bundle
and expire 48 hours later, when a redeploy refreshes them. See [DEPLOYMENT.md](DEPLOYMENT.md#media-turn-credentials).

## Development

### Prerequisites

- Node 26 (see `.nvmrc`) and npm 12+ to build locally.
- **No funded account is required** to browse and resolve `.dot` names - resolution is trustless, client-side, and
  read-only.
- The Polkadot App is only needed to log in and sign transactions inside a loaded dApp.
- The app targets **Paseo testnet** out of the box (see [Network configuration](#network-configuration)); point it at
  another chain by editing `packages/config`.

The project uses npm workspaces and [Turborepo](https://turbo.build).

```bash
nvm use                  # or any Node 26 install
npm install -g npm@latest
npm install
npm run preview          # Build + serve both apps on localhost:5173
```

This branch vendors the `@parity/truapi` and `@parity/truapi-host` 0.23.0 packages from the native integration layer
`feat/media-on-jam-seity` (#1011 plus the Media layer `feat/media-sessions`). `vendor/truapi-host.lock.json` records the
source revision, archive hashes, `dist/generated/client.js` digest, and browser and testing WASM digests. The pinned
revision is published on native #1217. The browser wallet artifact enables `wasm-signing-host`, without `test-host`.
Install the dependency tree recorded in `package-lock.json` with `npm ci`. To iterate against a local
truapi checkout instead, run:

```bash
npm run link:truapi
```

When dotli is not checked out under `truapi/hosts/dotli`, point the script at the truapi repo:

```bash
TRUAPI_REPO=/path/to/truapi npm run link:truapi
```

Return to the package versions recorded in `package-lock.json` with:

```bash
npm run unlink:truapi
```

UI test fixtures await `overlaysReady()` before interacting with lazy permission dialogs. Rate-limit cases use a
controlled clock so module loading and machine load do not consume the permission window. Retention behavior uses a
small explicit capacity; large timeline workloads have separate work-bound tests.

Settings browser checks await address-bar canonicalization with Playwright's URL assertions: persisted settings can be
ready before boot finishes rewriting the URL.

Bitswap unit fixtures load a fresh module before installing each case's provider, relay, or fake clock. Relay
installation is synchronous, so a timed-out import cannot install a listener after teardown. Protocol fixtures use the
real halt-error definitions without loading the browser transport implementation.

Local development uses wildcard subdomains:

- `host-playground.localhost:5173` — resolves `host-playground.dot` via the host

### Product locale and local time

The host reports the browser's language and IANA time zone through Locale, including changes detected on focus,
visibility, language changes, and a visible-tab minute timer. Locale's timestamp batch API formats each instant using
that zone's historical offset and daylight-saving rules; its canonical Gregorian local date is independent of the
display language. Products should use that date for day grouping rather than slicing a UTC timestamp.

The SDK provenance in `vendor/truapi-host.lock.json` pins the native source revision, original package archives, client
bundle, and both browser and testing WASM digests. Each browser stack layer vendors its matching native feature layer.

### Running the functional browser suite locally

Use the same instrumentation as CI. Metrics enable the light-client ownership checks, and the loopback Sentry DSN lets
the preview server collect their same-origin `/t` envelopes without contacting an external collector.

```bash
VITE_NETWORKS=paseo-next-v2,previewnet VITE_APP_DEBUG=true VITE_METRICS=true \
VITE_SENTRY_DSN=http://publickey@127.0.0.1:5173/1 npm run build
VITE_METRICS=true npm run --workspace apps/host test:functional
```

Both metric settings are required: without them the transport ownership cases either skip or collect no samples.

Functional CI retains JSON results and failure screenshots/traces in `functional-results-<attempt>` for three days. Open
a failed test's `trace.zip` with `npx playwright show-trace` to distinguish RPC/manifest resolution, gateway delivery,
and sandbox startup failures. The suite still resolves and loads the real published playground.

Gateway CAR requests select their representation with `?format=car`, leaving the browser's default Accept header intact.
A media-specific Accept header bypasses the Paseo gateway's immutable-content cache despite returning the same archive.
URL-based format selection follows [IPIP-0523](https://specs.ipfs.tech/ipips/ipip-0523/); requested-CID and CAR-block
verification remain unchanged.

### Qualifying a PolkaVM runtime update locally

Keep `vendor/truapi-host.lock.json` and the vendored host SDK unchanged when qualifying a runtime-only update. The
qualification suite uses the real host bridge and SDK; only name resolution and content-addressed CAR delivery are local
fixtures. Nothing is published, signed, or deployed.

```bash
npm ci
npx playwright install chromium
npm run prepare:polkavm-qualification
VITE_NETWORKS=paseo-next-v2,previewnet VITE_APP_DEBUG=true npm run build
npm run test:polkavm-qualification
```

Preparation archives the exact app-kit commit in `apps/host/tests/functional/fixtures/polkavm/qualification.lock.json`
into an isolated build directory under ignored `dist/polkavm-qualification/`. It does not use an arbitrary existing app
bundle. Install the recorded Rust nightlies with `rust-src`, `polkatool`, Clang, and LLVM tools first; the lock records
the producer's Node/npm/compiler versions. `PVM_CLANG`, `PVM_LLVM_AR`, and `PVM_LLVM_RANLIB` can select the
corresponding executables. `--source <clean-checkout>` avoids fetching app-kit, but still requires the exact pinned
revision and copies it into the isolated build. Dependencies remain locked and sccache is disabled.

The source pin uses the migrated `host_frame_*` guest SDK. Each fixture records the guest SDK revision, CAR CID, and
CAR/manifest/program SHA-256 hashes. Freedoom Phase 1 mounts only `game/freedoom1.wad`; Phase 2 mounts only
`game/freedoom2.wad`. The same engine selects its campaign by filename, not by examining replacement WAD bytes. Both
CARs include the campaign's licenses.

An intentional source/toolchain refresh uses `npm run prepare:polkavm-qualification -- --record-artifacts`. Review the
changed lock, then rerun preparation without that flag: ordinary preparation fails on toolchain or artifact mismatches.
This verifies repeat builds with the recorded toolchain, not cross-platform reproducibility; the pinned Doom build
enumerates C sources in filesystem order. Verified prepared fixtures can be copied to another browser test machine
without rebuilding them.

The suite covers handshake and private-storage write/read/clear through the unchanged SDK, both campaigns'
rendering/input/audio, file-consent cancellation and approval, warm compiler-cache restart, real tab background/resume,
and worker teardown. It runs headed to exercise actual visibility changes; use
`xvfb-run -a npm run test:polkavm-qualification` on a display-less Linux runner. Playwright results attach
fixture/runtime/SDK provenance, screenshots, passive worker observations, browser logs, and teardown evidence. Each
story gets a fresh Chromium profile, connected with Playwright's `noDefaults: true` so its usual focus emulation cannot
force background tabs to remain visible. Visibility is observed from the browser, never synthesized. Guest input waits
for the host loading overlay to disappear and uses canvas-relative, actionability-checked clicks. Use Playwright's
matching Chromium build; a system-browser override is not equivalent qualification evidence.

These fixtures do **not** qualify cartridge-save isolation: that needs a save-capable cartridge guest and two distinct
cartridge contents. Wallet signing and native hosts are also outside this suite.

### Running the host-playground E2E locally

The product E2E suite loads the source checkout through dotli's localhost proxy. CI pins
[host-playground](https://github.com/paritytech/host-playground) to `f56294cea4430163bf16ec068844b1327441073c`, installs
its frozen dependency lock, and links its TrUAPI consumers to this repository's installed `@parity/truapi` with
`node scripts/link-truapi-local.ts --product-vendor`. This runs the existing product behavior checks against the pinned
SDK rather than the independently deployed `host-playground.dot`. The deployed smoke suite below checks that separate
boundary. The product still calls the real host; no SDK responses are mocked. The pinned fixture requests bare host
patterns for `Remote` permissions; scheme-bearing URLs are intentionally rejected by the core before prompting.

CI and local Playwright runs use Node.js 26 and npm 12.

Local runs expect the product at `../../../host-playground` relative to this repository by default. The signing host
must match `upstreamRevision` in `vendor/truapi-host.lock.json`, not the latest released CLI. CI checks out that exact
[host-rust-core](https://github.com/paritytech/host-rust-core) commit, installs its `nightly-toolchain` pin with
`rustfmt` (or `nightly` for older feature SDK sources), generates its sources, and builds `truapi-host` locally.

To build the matching binary in a fresh sibling checkout, install Rust stable and Node.js 26/npm 12, then run from this
repository:

```bash
revision="$(jq -er '.upstreamRevision' vendor/truapi-host.lock.json)"
git clone --no-checkout https://github.com/paritytech/host-rust-core ../host-rust-core-e2e
git -C ../host-rust-core-e2e fetch --depth=1 origin "$revision"
git -C ../host-rust-core-e2e checkout --detach "$revision"
(
  cd ../host-rust-core-e2e
  toolchain=nightly
  if [[ -f nightly-toolchain ]]; then
    read -r toolchain < nightly-toolchain
  fi
  rustup toolchain install "$toolchain" --profile minimal --component rustfmt
  npm ci --ignore-scripts
  RUSTUP_TOOLCHAIN=stable TRUAPI_SKIP_PACKAGE_BUILD=1 ./scripts/codegen.sh
  cargo +stable build --locked -p truapi-host-cli --bin truapi-host
)
export SIGNING_HOST_BIN="$(pwd)/../host-rust-core-e2e/target/debug/truapi-host"
export TRUAPI_HOST_NO_UPDATE=1
echo "Signing-host source: https://github.com/paritytech/host-rust-core/commit/$revision"
"$SIGNING_HOST_BIN" --version
```

To qualify this branch's vendored SDKs, build dotli without linking a different SDK checkout, then run the host
workspace suite with explicit CLI and product paths:

```bash
VITE_NETWORKS=paseo-next-v2,previewnet VITE_APP_DEBUG=true npm run build
SIGNING_HOST_BIN=/path/to/pinned-host-rust-core/target/debug/truapi-host \
E2E_PRODUCT_REPO=/path/to/host-playground \
E2E_PRODUCT_URL=http://localhost:5199 \
SIGNING_HOST_NETWORK=paseo-next-v2 \
NEXT_PUBLIC_NETWORK_GENESIS_HASH=0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a \
npm run --workspace apps/host test:e2e:local
```

The root `npm run test:e2e:local` shortcut instead links a local SDK checkout through `npm run link:truapi`; use it only
when deliberately developing against that checkout. Set `TRUAPI_REPO` to select it.

The product's `NEXT_PUBLIC_NETWORK_GENESIS_HASH` must select the same Asset Hub as the host and `SIGNING_HOST_NETWORK`;
the fixture otherwise defaults to Previewnet and its chain queries are rejected by a Paseo host.

The suite defaults to `rpc-gateway`. Set `E2E_CHAIN_BACKEND` to run the same flow through either light-client backend:

```bash
E2E_CHAIN_BACKEND=smoldot-shared-worker npm run --workspace apps/host test:e2e:local
```

`SIGNING_HOST_BIN` also accepts an existing locally built binary; use an absolute path because the E2E command runs from
`apps/host`. Without it the suite looks up `truapi-host` on `PATH`; ensure that binary was built from the same lock
revision and disable self-updates with `TRUAPI_HOST_NO_UPDATE=1`. Rebuild when the lock revision changes, including when
switching between generic and Chat branches. Set `SIGNING_HOST_NETWORK` when testing against a non-default network. The
CLI keeps its account state under `apps/host/tests/e2e/.auth/signing-host`. The adapter uses canonical `--session`
selection with a unique bare username stem saved in `.dotli-e2e-session` under that state directory. Set
`SIGNING_HOST_SESSION` to choose a stem or an existing exact numbered username. A new stem must contain at least six
lowercase ASCII letters (digits and separators do not count). Repeated pairing attempts and runs reuse the same base
path and session, including unfinished setup. The first run provisions an account and can take a few minutes. With
`HOST_CLI_SIGNER_MNEMONIC`, no session flag is passed. Captured CLI diagnostics redact pairing deeplinks, the configured
mnemonic, and labeled recovery phrases; never attach the CLI's private account/session files to reports.

Playwright starts both preview servers, extracts the login QR deeplink, pairs a headless `truapi-host signing-host`
process that auto-signs for the rest of the run, and runs the same host-product suite used in CI.

### Checking a deployed host

The deployment smoke suites load published products through the deployed host, not the localhost fixture. The TrUAPI
suite exercises 19 wallet-free capabilities without pairing a signer or writing to the chain; it does not replace paired
E2E.

The PolkaVM playground smoke passively verifies a canonical handshake request and its correlated `Result::Ok` reply, not
merely increasing request/response counters. Input waits for a rendered frame and host loader dismissal, then uses an
actionability-checked canvas click. Wire/provenance attachments retain raw and decoded frames and executed-program
hashes on success and failure. A passing local fixture does not qualify a different published guest binary.

The Duke and Quake gameplay checks require actual browser Pointer Lock, not just a capture request. Duke starts directly
in a level, so its smoke does not send menu-navigation keys. The initial canvas click may already capture the pointer
and clear the armed flag; otherwise the check waits for arming and clicks to acquire capture.

PolkaVM execution is opt-in on `dot.li` and on by default on every other shell (`paseo.fyi`, `paseo.li`, previews,
localhost); **Settings → Experimental → PolkaVM apps** overrides the site default either way. Testnet product smoke
scenarios exercise a fresh visit without opting in. On production `dot.li`, the smoke explicitly enables the toggle with
**Save & Apply** first. An existing saved choice, including an opt-out on a testnet, remains authoritative. The site
default applies only when no valid preference has been saved.

The `echat` smoke stays signed out: it cancels the initial sign-in request, uses the guest's Retry button to open a
fresh host prompt, cancels again, and checks redraw and resize. An idle, demand-driven UI need not publish continuous
update telemetry. The game scenarios retain their continuous rendering, audio, and input checks.

```bash
cd apps/host
DOTLI_SMOKE_ROOT=paseo.fyi DOTLI_WEBGPU=1 npm run test:smoke:products -- --output=test-results/products
DOTLI_SMOKE_ROOT=paseo.fyi npm run test:smoke:truapi -- --output=test-results/truapi
```

The deployment workflow keeps the two suites' output directories separate and uploads failure screenshots, error
contexts, and Playwright traces as `deployed-product-smoke-<environment>-<attempt>`, retained for three days. Inspect
that artifact when a published product fails to load or a capability fails; a green localhost E2E run does not qualify
the deployed bundle.

### Running an approved build

Releases are published as GitHub Releases tagged `vX.Y.Z` (the latest published tag is what the hosted dotli deployment
runs). To reproduce a specific approved version from a fresh checkout:

```bash
git checkout v0.5.0       # any published release tag
npm ci
npm run build:prod        # production build of both apps
```

The published tag on the [Releases page](https://github.com/paritytech/dotli/releases) is the source of truth for what
is deployed; rebuild from that tag to verify a deployment.

## Debug panel

dot.li ships a TrUAPI debug panel that aggregates host-side activity (boot/resolve/render/bridge events, TrUAPI
host↔product messages, SSO/session events) into one time-aligned inspector. The panel chunk and stylesheet are
dynamically imported together, so its initial dock measurement uses the styled size even on a cold load. Users who never
see the panel pay no download cost.

The **Archive** tab explores the current product's files. Light-client reads use the host block cache before bitswap;
gateway mode uses the IPFS gateway. Its lazy mount retains a static stylesheet side-effect import so layout is measured
only after the panel CSS arrives.

In builds compiled with `VITE_APP_DEBUG=true` (local `npm run preview:debug`, and the staging dev deploy at
`paseoli.dev`) the panel auto-mounts collapsed. In staging/production it's off until you click **Open in debug mode** in
the host Settings menu (or append `?debug=true` to any URL). The choice is sessionStorage-scoped — closing the tab
clears it. Use `?debug=off` to silence it explicitly within the same session.

See [packages/truapi-debug/DEBUG_PANEL.md](packages/truapi-debug/DEBUG_PANEL.md) for the full reference — event sources,
views, filters, correlation keys, and how to add a new instrumentation hook.

### Experimental test wallet

Only builds compiled with `VITE_APP_DEBUG=true` offer the **Wallet** tab in the debug pane. Its compact header button
shows a wallet icon until an active full/Lite username is known, then only the username; click it to expand the pane and
select Wallet. Status changes do not change this button; verification, pending claims, and errors appear inside the
Wallet tab. Wallet shares the pane's existing bottom/right docking and resizing controls. Right docking reserves page
width for both the landing page and product content. There is no separate wallet window or docking preference. Normal
login continues to use Polkadot Mobile. Opening diagnostics with `?debug=true` or Settings in a production build does
**not** enable wallet creation or restoration; existing experimental wallet storage is ignored and preserved.

Start with **Use test wallet** and accept the warning to create or reuse a browser-local test identity. Username
controls appear only after activation completes. A newly created or imported wallet looks up its Lite username on chain
automatically once; if that lookup fails, the next load retries it. An existing Lite username replaces the claim form;
**Check username** verifies its on-chain ownership without submitting another registration. Account identifiers are
collapsed under **Account details**. While active, the account badge also opens the Wallet tab. Choose **Switch back to
Mobile** to stop using the test wallet without deleting it. The normal login button then signs in with Polkadot Mobile.
Mode changes reload the page to terminate the previous signing workers. Wallet tracks one active identity; it is not a
multi-identity wallet manager.

The encrypted wallet is shared by trusted product hosts under the same root domain, through the protocol origin's
IndexedDB. Browser profiles and different root domains remain isolated; moving an identity between them requires an
explicit recovery-phrase import. Existing origin-local wallets migrate only into an empty shared store or when they
match it. Conflicting wallets are preserved for recovery, and a deleted shared wallet cannot be silently restored by an
old origin-local copy.

Wallet identity belongs to the page's single host-owned native core, not the current product. It is available on the
landing page before any product loads. Product startup or replacement preserves wallet identity queries and claim
monitoring. Product accounts and permissions remain isolated by their native product connections within that core.

A full page reload restarts the native session. If this origin previously received an identity, the Wallet tab and
account badge immediately restore its public display metadata for the current wallet revision and network. The Wallet
tab marks it **verifying**, while the debug header button retains only the known username. This cache does not
authenticate the wallet or authorize claims, signing, or product permissions. Native verification replaces the cached
identity and names, including confirmed absence; a failed check retains the last-known display with an explicit failure
state in the Wallet tab. First visits without cached metadata still require native initialization.

If the native worker fails, the host retires the entire page core, including its product connections, and marks the
cached wallet identity as display-only. The product iframe remains visible, but its native connection is unavailable.
Verification failures do not open a Mobile pairing dialog or silently restart the wallet. **Retry wallet verification**
explicitly creates and verifies a fresh page core before enabling username and resource operations again; reload or
rerender the product to reconnect its iframe.

**Claim username** submits an explicitly confirmed registration on the selected network through the same-origin identity
proxy. The Wallet tab reports actual checking, authentication, submission, and confirmation stages with elapsed time. A
failed confirmation read shows an automatic retry state with expandable technical details; acceptance alone is never
shown as success. Switching tabs, collapsing the pane, or replacing a product does not cancel monitoring. The header
button shows the name only once it is reported by the wallet identity, not while a claim is pending. An accepted claim
is not resubmitted or reported as failed merely because confirmation is slow. Chain confirmation updates the claimed
state and shows a notification, including while another tab is selected. Disconnecting, replacing the wallet, or
reloading the entire page ends that session's monitoring. **Check username** discovers an existing registration,
including after importing a phrase in another profile; it is not needed to poll an in-progress claim. Unknown,
last-known, confirmed-unclaimed, pending, confirmed-claimed, and failed states are distinguished. Confirmed public
metadata is shared with other product hosts; live native sessions refresh in place without resetting their permissions.
A product-account refresh failure is reported separately from the confirmed wallet claim. Cached names are rechecked on
chain before being restored to a native session.

**Wallet** shows the network and wallet identity independently of the **Current product** section, which shows the
product account public key, native derivation context, and permissions. Allowance controls use the running product's
native resource-allocation API and require an explicit request confirmation; native approval remains in charge. The API
exposes allocation outcomes, not remaining quota, balances, amounts or fees. Results are labeled as last observed
outcomes, and uncertain results are not retried automatically.

Native Chat uses the wallet-owned main purse, private device records and a durable product index in the protocol
origin's IndexedDB. Closing a product connection does not stop receiving while the page's wallet core remains alive. A
page-product change retires the previous signer and releases its custody before starting the replacement; reload
restores only previously authorized devices, without prompting for fresh Chat authority in the background. Each payment
requires a new host review of the authenticated product and recipient, exact amount, maximum debit including fees,
selected chain and Coinage asset, and payment operation. Chat or automatic-signing grants never approve spending.
Private core records are authenticated-encrypted at rest; immutable attachment source Blobs are private to the trusted
host but are not encrypted at rest. They never enter product storage or the product RPC interface.

Contacts are read from the active native wallet and People-chain binding, never from a product-provided roster. The
Solid host picker cancels when its connection closes or the session, roster, wallet or network changes, and revalidates
a selection before returning a contact handle. Product prompts have connection-owned modal scopes; authentication,
private storage and attachment custody stay with the one page core.

Picker rows show verified contact names, with a generic label for unnamed contacts; raw account IDs are not displayed.

The multi-select picker opens with the current audience checked, preserves selections while searching, and applies them
only with **Use selection**. Confirming no checked contacts removes everyone; **Cancel**, Escape, and the backdrop leave
the audience unchanged. The original single-contact picker remains available.

Contact names and account identities remain host-private. Products receive opaque contact handles and can reserve
clipped label boxes on their surface; the host draws verified contact usernames, or account identifiers when no username
is available, above the product frame. These labels do not require a shared profile or photo, and are independent of
Profile avatar placement. Same-wallet contact-directory changes clear stale names and refresh the latest placement
without waiting for the product to redraw. Product restart, navigation, wallet/session replacement, an empty placement,
and frame teardown cancel pending refreshes and remove labels.

Use the existing **List**, **Timeline**, and **Resolution** tabs for activity and diagnostics. Wallet does not duplicate
their event viewer or capture controls.

Under **Debug → Wallet → Recovery**, **Reveal recovery phrase** requires confirmation before displaying a selectable
phrase for manual backup. Recovery is collapsed by default. Existing 32-byte wallets export as 24 English BIP-39 words
without changing their identity. Nothing is automatically copied or downloaded; hiding the phrase, closing Recovery,
switching away from Wallet, collapsing or closing the pane, or hiding the page clears sensitive controls. Import and
deletion controls are confined to Recovery.

**Import / replace test wallet** accepts checksum-valid English BIP-39 phrases of 12, 15, 18, 21 or 24 words, without a
passphrase or custom derivation path. It uses native Polkadot host/Substrate derivation, not Bitcoin/Ethereum seed
derivation. Importing an exported phrase restores the same account keys on the same network, but not permissions; its
registered username is looked up automatically. Back up the previous test wallet before replacing it. Successful import
replaces the shared wallet for trusted product hosts, clears wallet-bound experimental session/signing grants, activates
the imported wallet and reloads open tabs; Mobile pairing and grants remain separate.

**Delete test wallet** requires confirmation and removes the shared wallet's stored entropy and this origin's preserved
legacy copy, while retiring experimental session/signing grants. Wallet-scoped purse and Chat records are retained
separately, not silently erased by identity replacement or deletion; restoring the same identity still requires fresh
permissions. A recovery phrase restores identity keys, not a backup of private purse or Chat records. Clearing site data
can therefore destroy private state even when the phrase is backed up.

Only one tab of a browser profile runs the test wallet at a time, because two tabs starting their own wallet cores would
claim allowances twice and overwrite each other's state. Opening an app with the test wallet in another tab moves it
there automatically: the tab that had it stops its wallet first, then hands it over. That tab keeps its app on screen
with a **Paused** banner and takes the wallet back the next time you click or type in it; background activity never
moves the wallet, so two tabs cannot bounce it between them. If the tab that has it does not respond, the new tab shows
**Test wallet is open in another tab**; close the other tab and reload. Ownership requires the browser's Web Locks API;
there is no unlocked fallback. A handover acknowledges release only after the previous owner's signing workers,
including workers still booting, have stopped. An unresponsive owner is never forcibly bypassed after a timeout.

Safari keeps each app's storage separate, so there every app has its own test wallet and the one-tab rule only covers
tabs of the same app. Importing the same recovery phrase into two apps runs two copies of one wallet with nothing
coordinating them; avoid using both at once. When another app already has a wallet, the wallet panel warns that **Use
test wallet** would start a different one. Chrome, Brave and other Chromium browsers share one wallet across apps.

This is experimental custody, not a secure vault: malicious scripts on any trusted host origin can recover the shared
keys despite encryption. Wallet secrets never enter sandbox origins or HTTP mode synchronization. Never use valuable
funds or import a real wallet. Debug builds can still access real networks and sign real transactions.

Keep `VITE_APP_DEBUG` unset or false in production builds.

### Seity profiles

Profile sharing uses the native core's separate **Profile Disclosure** consent. It does not authorize identity
disclosure, transaction signing, spending, or statement submission. Dismissing a disclosure prompt leaves it undecided;
an explicit denial is persisted by the core.

The host resolves Seity contact references through the active network's registry and decrypts Bulletin content outside
the product frame. Profile references are bearer capabilities: their storage follows the existing encrypted native
wallet custody and wallet/network namespaces. A network without a configured registry has no contact profile to display.

Profiles and contact-avatar layers are Solid host surfaces attached to the product's connection to the shared page core.
Closing or retiring the connection aborts pending loads, removes its drawer and avatars, and releases decrypted image
URLs. Profile content is self-described; verified Chat attribution confirms who shared a reference, not who an image
depicts.

Opening a contact without a received, live profile reference still opens the host drawer. It shows the host-verified
contact name and **No information shared with you yet**, without an error style or an indefinite spinner. It does not
claim the contact has never shared: information may not have reached this host yet. Availability stays private from the
requesting product, whose completion reply is the same for shared and empty profiles. When a product-specific Chat name
is unavailable, the drawer resolves it from the same wallet- and People-network-bound verified directory used by contact
labels. This lookup never delays opening the drawer or returns the name to the requesting product. Missing or
unavailable directory names retain generic attribution.

## Sandbox API Checker

dApps rendered in dotli's sandboxed iframe should communicate exclusively through the container bridge (postMessage),
not use web APIs directly. The sandbox checker detects restricted API usage and reports violations in a UI panel.

The checker is activated by defining `VITE_SANDBOX_CHECKER` at build time (e.g. `=true`). When the env var is unset, the
gated import is statically eliminated, so the checker is tree-shaken out of production builds entirely.

### Monitored APIs

| Category | APIs                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| Network  | `fetch`, `XMLHttpRequest`, `WebSocket`, `RTCPeerConnection`, `EventSource`, `sendBeacon` |
| Workers  | `Worker`, `SharedWorker`, `ServiceWorker.register`                                       |
| Storage  | `localStorage`, `sessionStorage`, `IndexedDB`, `CacheStorage`, `document.cookie`         |
| DOM      | `document.createElement('iframe')`                                                       |
| Wallet   | `window.injectedWeb3`, `window.polkadot`, `window.ethereum`                              |

Same-origin requests (static dApp files served by the Service Worker) are excluded from reporting for `fetch` and
`XMLHttpRequest`. Violations are logged, but calls still proceed (log-and-forward pattern).

The violation panel appears at the bottom of the viewport when the first violation is detected, showing the API name,
details, and timestamp for each call.

## Network configuration

A build offers the networks listed in the required `VITE_NETWORKS` env var, set at deploy time (see
`packages/config/src/network.ts`). The first entry is the default returned by `defaultNetwork()`.

- **dotNS Registry**: `0xa1b2b939E82b2ecE55Bd8a0E283818BfC1CA6CDc`
- **dotNS ContentResolver**: `0x8A26480b0B5Df3d4D9b95adc24a5Ecb33A5b8F64`
- **Bulletin Chain RPC**: `wss://paseo-bulletin-next-rpc.polkadot.io` (WebSocket)
- **IPFS gateway**: `https://paseo-bulletin-next-ipfs.polkadot.io`

All addresses, endpoints, and selector labels live in `packages/config/src/network.ts`
(`NETWORK_NAME_TO_SERVICES_CONFIG`).

### Prebuilt bundles

Each release also publishes two prebuilt artifacts, so a forked dev chain can be browsed without building anything. Both
take the same network override at **run time**, so one artifact works against any chain:

```bash
# container
docker run -p 5173:5173 -e DOTLI_NETWORK='{…}' ghcr.io/paritytech/dotli-community:0.7.4

# tarball — needs only node >= 22 or bun
DOTLI_NETWORK='{…}' node serve.mjs
```

Overrides patch the tables above and reach endpoints only — `label`, `rpcs` and `ipfsGateways`. Genesis hashes and
contract addresses stay fixed at build time, because they are the trust root for name resolution. See
[docs/docker.md](docs/docker.md).

## Security

Before deploying it for real use cases, **you are responsible** for:

- **Reviewing** the code yourself, we publish a reference, not a hardened production build
- **Checking** that the dependencies are up to date and free of known vulnerabilities
- **Securing** your own fork or deployment environment (keys, secrets, network configuration)
- **Tracking** the latest tagged release/commits for security fixes; older releases are not backported (exceptions might
  apply)

Secret Scan covers all fetched branch history. `.gitleaks.toml` documents the public chain data and throwaway test
vectors excluded from credential checks.

For Parity's security disclosure process, and **Bug Bounty** program, feel free to visit: https://parity.io/bug-bounty

### Reporting a vulnerability

This repository inherits the organization-wide security policy. **Do not** open a public issue for security reports.
Follow the Parity security policy at [SECURITY](./SECURITY.md).

## License

dotli is licensed under the **GNU Affero General Public License v3.0** (`AGPL-3.0-only`). See [LICENSE](./LICENSE).

Third-party dependencies are distributed under their own licenses; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
