> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

<div align="center">

# dotli

[![Website](https://img.shields.io/badge/paseo.li-online-blue?style=flat-square)](https://paseo.li)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Polkadot](https://img.shields.io/badge/polkadot-ecosystem-E6007A?style=flat-square&logo=polkadot)](https://polkadot.com)

A decentralized web browser that runs in your browser. Visit any Polkadot application with fully trustless, client-side resolution — no servers in the loop.

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

dotli uses a **two-build, per-product subdomain architecture** that separates concerns between the host shell and the app content layer:

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

Each product gets its own `<label>.app.paseo.li` origin, so versions of the same product share an origin while different products stay isolated for SW/storage/security purposes.

### What it does

1. **Resolves** `.dot` names via an in-browser [smoldot](https://github.com/paritytech/smoldot) light client connected to Asset Hub Paseo, querying dotNS contracts.
2. **Fetches** content from the [Bulletin Chain](https://github.com/paritytech/polkadot-bulletin-chain) via smoldot `bitswap_v1_get` JSON-RPC or an IPFS gateway.
3. **Renders** the content in a sandboxed iframe with the Rust-backed TrUAPI bridge, so loaded SPAs can request accounts, sign transactions, connect to chains, and use scoped storage.
4. **Runs** verified framebuffer PolkaVM products by translating `app.polkavm` to WebAssembly at load time inside a worker, with a bounded interpreter fallback.

```
host-playground.paseo.li
    -> Host: smoldot resolves dotNS -> IPFS CID
    -> Host: iframes <label>.app.paseo.li with cid in URL contract
    -> App:  fetches content via smoldot bitswap_v1_get or IPFS gateway
    -> App:  renders dApp in sandboxed iframe with container bridge
```

Single-file apps are served as blob URLs. Multi-file SPAs (directories) are fetched as CAR archives, parsed, and served through a Service Worker that acts as a virtual file system.

### What it doesn't do

- It is **not** a wallet or key custodian. Per-app keys are derived on demand via HDKD soft derivation, and signing is delegated to the connected Polkadot App session.
- It does **not** run its own RPC servers or backends. Chain access is through an in-browser smoldot light client, and dotNS records are read directly from the contract storage.
- It does **not** pin or host content. Content is fetched from the Bulletin Chain or an IPFS gateway and served locally per session.
- It is **not** a production-hardened product. Treat it as a reference blueprint (see [Security](#security)).

## How resolution works

1. Parse the label from the subdomain (`host-playground.paseo.li` -> `host-playground`)
2. Compute the ENS-style namehash (`node`) of the name — the resolver tries `app.<label>.dot` first and falls back to `<label>.dot`
3. Read the `contenthash` bytes for `node` directly from the dotNS ContentResolver contract storage
4. Decode the contenthash bytes to an IPFS CID (using `@ensdomains/content-hash`)
5. Create an iframe to `<label>.app.paseo.li?cid=<cid>` which fetches and renders the content

All chain access is read-only storage reads through the smoldot light client — no RPC server needed. (An optional gateway backend reads the same storage over a public RPC node instead.)

## How multi-file SPAs work

When a CID points to an IPFS directory (not a single file):

1. The gateway returns a CAR (Content-Addressable aRchive) containing all files
2. `archive.ts` parses the CAR using `@ipld/car` + `@ipld/dag-pb` + `ipfs-unixfs` to extract a file map
3. The file map is sent to the app Service Worker via `postMessage`
4. The iframe loads from `/dotli-app/index.html` — the SW intercepts all requests and serves files from the in-memory archive
5. Relative imports (`<script src="main.js">`, `<link href="styles.css">`) just work

## How PolkaVM apps work

An archive whose `manifest.json` declares `runtime.kind: "polkavm"` never
executes package-owned HTML. The sandbox instead creates a host-owned canvas,
loads the verified `app.polkavm` and immutable package assets, and translates
the program to WebAssembly inside a worker. Keyboard, pointer, framebuffer,
PCM-audio, asset, save, and UI integration traffic stays on the bounded
PolkaVM Host ABI.

App manifest v2 supports framebuffer, Tri2D, and WebGPU Raster ABI version 1.
WebGPU commands execute in a dedicated Host worker after bounded capability
negotiation; TrUAPI, MotionSample v1, text, IME, focus, and wheel input use the
same pinned browser runtime as native Hosts. UI output v1 applies cursor and
IME-agent state in the sandbox. Clipboard text and HTTP(S) navigation cross an
origin-checked parent channel; the Host consumes at most one command per recent
trusted input and does not grant the app iframe clipboard permission. As an
interim compatibility policy, framebuffer and WebGPU Raster capture the pointer
after a primary click while Tri2D leaves it free.

Translated Wasm bytes are cached in product-origin IndexedDB by the SHA-256 of
the PVM program and the pinned translator version. Warm launches skip PVM
instruction lowering; WebAssembly compilation remains browser-owned. If
translation or Wasm compilation fails, the same worker retries through the
bounded interpreter.

## Caching and verification

dotli uses three cache layers for fast repeat visits:

1. **CID cache** (IndexedDB) — maps `.dot` labels to their last-known CID
2. **Archive cache** (Service Worker) — stores fetched file maps keyed by domain; a cache hit additionally requires the stored CID (and content backend) to match
3. **PVM translation cache** (IndexedDB) — stores translated Wasm bytes keyed by translator version and PVM program digest

On repeat visits, content renders instantly from the cache while it is resolved in the background. The topbar shield shows how the current page was loaded:

| Shield           | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| Green (Verified) | Checked by your in-browser light client (the default smoldot backend)         |
| Orange (Trusted) | Served by an external RPC provider or IPFS gateway, not light-client verified |

If a background re-resolution finds the on-chain CID has changed, dotli shows a **New version available** notification with a **Reload** action rather than swapping content silently.

## TrUAPI bridge

Loaded SPAs communicate with dotli through a postMessage-based protocol. The bridge exposes:

| Handler                        | What it does                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `accountGet`                   | Derives a per-app public key via HDKD soft derivation                                 |
| `getLegacyAccounts`            | Returns non-derived (imported) accounts — always empty on the web host                |
| `signPayload` / `signRaw`      | Shows signing modals and routes signing through the active session                    |
| `chainConnection`              | Returns an isolated broker connection over the selected chain backend                 |
| `localStorageRead/Write/Clear` | Scoped `localStorage` per `.dot` domain                                               |
| `navigateTo`                   | Opens URLs in new tabs                                                                |
| `featureSupported`             | Reports whether a feature is supported (e.g. a chain's genesis hash)                  |
| `connectionStatus`             | Streams auth state changes to the SPA                                                 |
| `chat.*`                       | Product chat: rooms and messages persisted locally, rendered in the topbar chat panel |

### Product chat

Products that declare `includes.chat` in their `worker.<label>.<tld>`
executable manifest get a Worker-kind TrUAPI execution and a chat button in
the topbar. The product drives the conversation over the core's chat
surface (`chat.create_room`, `chat.register_bot`, `chat.post_message`,
`chat.list_subscribe`, `chat.action_subscribe`); the user replies from the
docked chat panel, and each reply reaches the product as a `MessagePosted`
action. Rooms and messages persist in IndexedDB on the product origin and
never leave the device. The core denies chat calls without an active
session, so chat requires being logged in. The localhost debug paths enable
chat unconditionally so local products can be tested without publishing a
manifest.

Custom messages (`ChatMessageContent::Custom`) render live: when a custom
message cell scrolls into view, the panel asks the product to draw it
(`chat.custom_message_render`) and renders the streamed tree with the
host's own design system (`src/chat/custom-renderer.ts`). The tree is a
closed vocabulary of layouts and design tokens, so a product can never
inject markup, styles, or URLs. Button taps and text-field edits flow back
as `ActionTriggered` actions, as do taps on `Actions`-content buttons.

### App iframe model

The host creates one TrUAPI bridge for the rendered product iframe. dApp-in-dApp iframes are opaque to the host and must use the top-level product's shared Rust core/provider context rather than separate host-created bridges.

The app context uses `document.write()` to eliminate extra iframe nesting: when loaded inside a host iframe, the app replaces its own document with the dApp content so the dApp occupies the iframe directly.

## Development

### Prerequisites

- [Bun](https://bun.sh) 1.3+ and Node 22+ to build locally.
- **No funded account is required** to browse and resolve `.dot` names - resolution is trustless, client-side, and read-only.
- The Polkadot App is only needed to log in and sign transactions inside a loaded dApp.
- The app targets **Paseo testnet** out of the box (see [Network configuration](#network-configuration)); point it at another chain by editing `packages/config`.

The project uses [Bun](https://bun.sh) and [Turborepo](https://turbo.build).

```bash
curl -fsSL https://bun.sh/install | bash
bun install
bun run preview          # Build + serve both apps on localhost:5173
```

The TrUAPI packages are installed from their published `@parity` packages. To
iterate against a local truapi checkout instead, run:

```bash
bun run link:truapi
```

When dotli is not checked out under `truapi/hosts/dotli`, point the script at
the truapi repo:

```bash
TRUAPI_REPO=/path/to/truapi bun run link:truapi
```

Return to the package versions recorded in `bun.lock` with:

```bash
bun run unlink:truapi
```

Local development uses wildcard subdomains:

- `host-playground.localhost:5173` — resolves `host-playground.dot` via the host

### Running the host-playground E2E locally

The product E2E suite can load the source checkout directly through dotli's
localhost proxy instead of resolving the published `host-playground.dot` CID.
By default it expects the product at `../../../host-playground` relative to
this repository, and the `truapi-host` CLI from
[host-rust-core](https://github.com/paritytech/host-rust-core) on `PATH`:

```bash
curl -fsSL https://raw.githubusercontent.com/paritytech/host-rust-core/main/scripts/truapi-host-installer.sh | bash
```

```bash
bun run test:e2e:local
```

Override either checkout or server when needed:

```bash
E2E_PRODUCT_REPO=/path/to/host-playground \
E2E_PRODUCT_URL=http://localhost:5199 \
bun run test:e2e:local
```

The suite defaults to `rpc-gateway`. Set `E2E_CHAIN_BACKEND` to run the same
flow through either light-client backend:

```bash
E2E_CHAIN_BACKEND=smoldot-shared-worker bun run test:e2e:local
```

Set `SIGNING_HOST_BIN` to a locally built binary (e.g.
`../host-rust-core/target/debug/truapi-host`) instead of installing, and
`SIGNING_HOST_NETWORK` when testing against a non-default network. The CLI
keeps its account state under `apps/host/tests/e2e/.auth/signing-host`, so
repeat runs reuse one test account; the first run registers a fresh lite
username on-chain and can take a few minutes.

The command builds dotli with its debug-only localhost proxy enabled, starts
both preview servers through Playwright, extracts the login QR deeplink, pairs
a headless `truapi-host signing-host` process that auto-signs for the rest of
the run, and runs the same host-product suite used in CI.

### Running an approved build

Releases are published as GitHub Releases tagged `vX.Y.Z` (the latest published tag is what the hosted dotli deployment runs). To reproduce a specific approved version from a fresh checkout:

```bash
git checkout v0.5.0       # any published release tag
bun install
bun run build:prod        # production build of both apps
```

The published tag on the [Releases page](https://github.com/paritytech/dotli/releases) is the source of truth for what is deployed; rebuild from that tag to verify a deployment.

## Debug panel

dot.li ships a TrUAPI debug panel that aggregates host-side activity (boot/resolve/render/bridge events, TrUAPI host↔product messages, SSO/session events) into one time-aligned inspector. The panel chunk is dynamically imported, so users who never see it pay no download cost.

In builds compiled with `VITE_APP_DEBUG=true` (local `bun run preview:debug`, and the staging dev deploys at `paseoli.dev` / `dotli.dev`) the panel auto-mounts collapsed. In staging/production it's off until you click **Open in debug mode** in the host Settings menu (or append `?debug=true` to any URL). The choice is sessionStorage-scoped — closing the tab clears it. Use `?debug=off` to silence it explicitly within the same session.

See [packages/truapi-debug/DEBUG_PANEL.md](packages/truapi-debug/DEBUG_PANEL.md) for the full reference — event sources, views, filters, correlation keys, and how to add a new instrumentation hook.

## Sandbox API Checker

dApps rendered in dotli's sandboxed iframe should communicate exclusively through the container bridge (postMessage), not use web APIs directly. The sandbox checker detects restricted API usage and reports violations in a UI panel.

The checker is activated by defining `VITE_SANDBOX_CHECKER` at build time (e.g. `=true`). When the env var is unset, the gated import is statically eliminated, so the checker is tree-shaken out of production builds entirely.

### Monitored APIs

| Category | APIs                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| Network  | `fetch`, `XMLHttpRequest`, `WebSocket`, `RTCPeerConnection`, `EventSource`, `sendBeacon` |
| Workers  | `Worker`, `SharedWorker`, `ServiceWorker.register`                                       |
| Storage  | `localStorage`, `sessionStorage`, `IndexedDB`, `CacheStorage`, `document.cookie`         |
| DOM      | `document.createElement('iframe')`                                                       |
| Wallet   | `window.injectedWeb3`, `window.polkadot`, `window.ethereum`                              |

Same-origin requests (static dApp files served by the Service Worker) are excluded from reporting for `fetch` and `XMLHttpRequest`. Violations are logged, but calls still proceed (log-and-forward pattern).

The violation panel appears at the bottom of the viewport when the first violation is detected, showing the API name, details, and timestamp for each call.

## Network configuration

A build offers the networks listed in the required `VITE_NETWORKS` env var, set at deploy time (see `packages/config/src/network.ts`). The first entry is the default returned by `defaultNetwork()`.

- **dotNS Registry**: `0xa1b2b939E82b2ecE55Bd8a0E283818BfC1CA6CDc`
- **dotNS ContentResolver**: `0x8A26480b0B5Df3d4D9b95adc24a5Ecb33A5b8F64`
- **Bulletin Chain RPC**: `wss://paseo-bulletin-next-rpc.polkadot.io` (WebSocket)
- **IPFS gateway**: `https://paseo-bulletin-next-ipfs.polkadot.io`

All addresses, endpoints, and selector labels live in `packages/config/src/network.ts` (`NETWORK_NAME_TO_SERVICES_CONFIG`).

### Prebuilt bundles

Each release also publishes two prebuilt artifacts, so a forked dev chain can be browsed without building anything. Both take the same network override at **run time**, so one artifact works against any chain:

```bash
# container
docker run -p 5173:5173 -e DOTLI_NETWORK='{…}' ghcr.io/paritytech/dotli-community:0.7.4

# tarball — needs only node >= 22 or bun
DOTLI_NETWORK='{…}' node serve.mjs
```

Overrides patch the tables above and reach endpoints only — `label`, `rpcs` and `ipfsGateways`. Genesis hashes and contract addresses stay fixed at build time, because they are the trust root for name resolution. See [docs/docker.md](docs/docker.md).

## Security

Before deploying it for real use cases, **you are responsible** for:

- **Reviewing** the code yourself, we publish a reference, not a hardened production build
- **Checking** that the dependencies are up to date and free of known vulnerabilities
- **Securing** your own fork or deployment environment (keys, secrets, network configuration)
- **Tracking** the latest tagged release/commits for security fixes; older releases are not backported (exceptions might apply)

For Parity's security disclosure process, and **Bug Bounty** program, feel free to visit: https://parity.io/bug-bounty

### Reporting a vulnerability

This repository inherits the organization-wide security policy. **Do not** open a public issue for security reports. Follow the Parity security policy at [SECURITY](./SECURITY.md).

## License

dotli is licensed under the **GNU Affero General Public License v3.0** (`AGPL-3.0-only`). See [LICENSE](./LICENSE).

Third-party dependencies are distributed under their own licenses; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
