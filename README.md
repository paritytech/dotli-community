<div align="center">

# dot.li

[![Website](https://img.shields.io/badge/dot.li-online-blue?style=flat-square)](https://dot.li)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Polkadot](https://img.shields.io/badge/polkadot-ecosystem-E6007A?style=flat-square&logo=polkadot)](https://polkadot.com)

A decentralized web browser that runs in your browser. Visit any Polkadot application with fully trustless, client-side resolution — no servers in the loop.

[Website](https://dot.li) | [Report an Issue](https://github.com/paritytech/dotli/issues)

</div>

---

## How to access apps

dot.li supports two URL formats:

| Format        | Example                         |
| ------------- | ------------------------------- |
| **Subdomain** | `https://testingout.dot.li`     |
| **Path**      | `https://dot.li/testingout.dot` |

### Landing page

When visiting the root (`dot.li`, or `paritytech.github.io/dotli/`), a landing page is shown with:

- A **search bar** where users type an app name (`.dot` suffix is pre-filled) and navigate
- **Recently visited** apps shown as pill-shaped shortcuts (persisted in localStorage)
- A **Polkadot App login** button in the top-right corner

The topbar is hidden on the landing page and only appears when viewing an app.

## Architecture

dot.li uses a **two-build, CID-subdomain architecture** that separates concerns between the host shell and the app content layer:

```
name.dot.li              Host build (topbar, dotns resolution, smoldot, bridge)
                          Resolves name -> CID, then iframes cid.app.dot.li

cid.app.dot.li           App build (CID from subdomain, P2P fetch, render)
                          Parses CID from URL, fetches via P2P/gateway, renders
```

| URL                            | Role         | What happens                                                     |
| ------------------------------ | ------------ | ---------------------------------------------------------------- |
| `testingout.dot.li`            | Host shell   | Resolves `testingout` via dotns, iframes `bafyrei....app.dot.li` |
| `bafyrei....app.dot.li`        | App content  | Parses CID from subdomain, fetches content, renders              |
| `dot.li`                       | Landing page | Search bar, recent apps                                          |
| Direct `bafyrei....app.dot.li` | Standalone   | Works without a host — fetches and renders directly              |

Each `cid.app.dot.li` is a distinct origin, preventing SW/storage/security conflicts between apps.

### What it does

1. **Resolves** `.dot` names via an in-browser [smoldot](https://github.com/smol-dot/smoldot) light client connected to Asset Hub Paseo, querying dotNS contracts through the Revive EVM pallet.
2. **Fetches** content from the [Bulletin Chain](https://github.com/paritytech/polkadot-bulletin-chain) via [Helia](https://github.com/ipfs/helia) P2P (bitswap), with IPFS gateway fallback.
3. **Renders** the content in a sandboxed iframe with the Rust-backed TrUAPI bridge, so loaded SPAs can request accounts, sign transactions, connect to chains, and use scoped storage — all through a `MessageChannel`.

```
testingout.dot.li
    -> Host: smoldot resolves dotNS -> IPFS CID
    -> Host: iframes cid.app.dot.li
    -> App:  Helia fetches content (P2P or gateway)
    -> App:  renders dApp in sandboxed iframe with TrUAPI bridge
```

Single-file apps are served as blob URLs. Multi-file SPAs (directories) are fetched as CAR archives, parsed, and served through a Service Worker that acts as a virtual file system.

## How resolution works

1. Parse label from URL — subdomain (`testingout.dot.li` -> `testingout`) or path (`/testingout.dot` -> `testingout`)
2. Compute ENS-style namehash of `testingout.dot`
3. Call `recordExists(node)` on the dotNS Registry contract via Revive dry-run
4. Call `contenthash(node)` on the dotNS ContentResolver contract
5. Decode the contenthash bytes to an IPFS CID (using `@ensdomains/content-hash`)
6. Create an iframe to `cid.app.dot.li` which fetches and renders the content

All contract calls are read-only dry-runs executed through the smoldot light client — no RPC server needed.

## How multi-file SPAs work

When a CID points to an IPFS directory (not a single file):

1. The gateway returns a CAR (Content Addressable aRchive) containing all files
2. `archive.ts` parses the CAR using `@ipld/car` + `@ipld/dag-pb` + `ipfs-unixfs` to extract a file map
3. The file map is sent to the app Service Worker via `postMessage`
4. The iframe loads from `/dotli-app/index.html` — the SW intercepts all requests and serves files from the in-memory archive
5. Relative imports (`<script src="main.js">`, `<link href="styles.css">`) just work

## Caching and verification

dot.li uses a two-layer cache for fast repeat visits:

1. **CID cache** (IndexedDB) — maps `.dot` labels to their last-known CID
2. **Archive cache** (Service Worker) — stores fetched file maps keyed by domain + CID

On repeat visits, content renders instantly from cache while smoldot validates the CID in the background. The topbar shield indicates the verification state:

| Shield | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| Yellow | Validating — rendering from cache, checking on-chain        |
| Green  | Verified — on-chain CID matches cached version              |
| Orange | Gateway — resolved via gateway, awaiting chain confirmation |
| Red    | Outdated — on-chain CID differs; an update banner appears   |

## TrUAPI Rust bridge

Loaded SPAs communicate with dot.li through the shared Rust TrUAPI core exposed by `@parity/truapi-host-wasm`. dot.li starts the core in a Web Worker, connects it to the product iframe with a dedicated `MessageChannel`, and implements host callbacks for UI, storage, chain access, notifications, preimage, and product-local storage.

| Handler                        | What it does                                                  |
| ------------------------------ | ------------------------------------------------------------- |
| `accountGet`                   | Derives a per-app public key via HDKD soft derivation         |
| `getNonProductAccounts`        | Returns the connected Polkadot App account                    |
| `signPayload` / `signRaw`      | Uses the core-owned SSO session channel for wallet approval   |
| `chainConnection`              | Returns a smoldot-backed JsonRpcProvider for supported chains |
| `localStorageRead/Write/Clear` | Scoped `localStorage` per `.dot` domain                       |
| `navigateTo`                   | Opens URLs in new tabs                                        |
| `featureSupported`             | Reports supported chain genesis hashes                        |
| `connectionStatus`             | Streams auth state changes to the SPA                         |

Login and logout are core-owned. Pairing is initiated through the SSO QR/deeplink flow, the Rust core validates and persists an opaque single-session blob under host storage, and the topbar disconnect button calls the core public `disconnect()` path. UI code does not clear the session store directly.

### Nested dApp support

Nested dApps are not given separate host runtimes, sessions, product identities, or storage namespaces in the Rust bridge cutover. Product content should use the shared Rust core exposed by the active host bridge. The previous dynamic nested bridge detector is intentionally not ported as an independent bridge model.

The app context uses `document.write()` to eliminate extra iframe nesting: when loaded inside a host iframe, the app replaces its own document with the dApp content so the dApp occupies the iframe directly.

## Development

The project uses [Bun](https://bun.sh) and [Turborepo](https://turbo.build).

```bash
curl -fsSL https://bun.sh/install | bash
bun install
bun run preview          # Build + serve both apps on localhost:5173
```

Local development uses wildcard subdomains:

- `testingout.localhost:5173` — resolves `testingout.dot` via the host
- `bafyrei....app.localhost:5173` — fetches and renders CID content directly

## Sandbox API Checker

dApps rendered in dot.li's sandboxed iframe should communicate exclusively through TrUAPI, not use host-controlled web APIs directly. The sandbox checker detects restricted API usage and reports violations in a UI panel.

The checker is activated by setting `VITE_SANDBOX_CHECKER=true` at build time. When the env var is not set, the checker is tree-shaken out of production builds entirely.

### Monitored APIs

| Category | APIs                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| Network  | `fetch`, `XMLHttpRequest`, `WebSocket`, `RTCPeerConnection`, `EventSource`, `sendBeacon` |
| Workers  | `Worker`, `SharedWorker`, `ServiceWorker.register`                                       |
| Storage  | `localStorage`, `sessionStorage`, `IndexedDB`, `CacheStorage`, `document.cookie`         |
| DOM      | `document.createElement('iframe')`                                                       |
| Wallet   | `window.injectedWeb3`, `window.polkadot`, `window.ethereum`                              |

Same-origin requests (static dApp files served by the Service Worker) are excluded from reporting for `fetch` and `XMLHttpRequest`. Violations are logged but calls still proceed (log-and-forward pattern).

The violation panel appears at the bottom of the viewport when the first violation is detected, showing the API name, details, and timestamp for each call.

## Network configuration

The app currently targets **Paseo testnet**:

- **dotNS Registry**: `0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f`
- **dotNS ContentResolver**: `0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7`
- **Bulletin Chain peers**: 4 Parity-hosted collator/RPC nodes (WebSocket)
- **IPFS gateway**: `https://paseo-ipfs.polkadot.io`

All addresses and endpoints are in `packages/config/src/config.ts`.
