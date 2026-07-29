<!--
Copyright 2026 Parity Technologies (UK) Ltd.
SPDX-License-Identifier: AGPL-3.0-only
-->

# @dotli/host-cli

Terminal host for the TrUAPI Rust/WASM core
([`@parity/truapi-host`](https://www.npmjs.com/package/@parity/truapi-host)).

A **host** is the platform half of a TrUAPI deployment: it implements the
core's 18 platform callbacks and owns the user-facing surface. dotli's web
host answers the core with modals, localStorage, and a Web Worker; this
package is its **terminal peer**: a QR in the terminal for pairing, readline
confirm prompts, owner-only (0600) file storage, pooled WebSocket chain
connections, and the core running in-process via `initSync`. Neither host
depends on the other; both depend directly on `@parity/truapi-host`.

```
                @parity/truapi-host   (Rust -> WASM host engine)
                    ▲                            ▲
     browser impls  │                            │  terminal impls
   dotli web host (packages/ui)         @dotli/host-cli (this package)
   modals, localStorage, Worker         QR, prompts, files, in-process
```

An embedding CLI app **is its own host**: it supplies its identity
(`host: {name, icon, version}`), the wallet deeplink scheme, the
people/bulletin genesis hashes, and the chains it serves. Nothing here is
dotli- or network-specific.

## Usage

```ts
import { createCliHost } from "@dotli/host-cli";
import { createClient, createTransport } from "@parity/truapi";

const host = await createCliHost({
  host: { name: "my-cli", version: "1.0.0" },
  pairing: { deeplinkScheme: "polkadotapp" },
  people: { genesisHash: "0x…" },
  bulletin: { genesisHash: "0x…" },
  chains: { "0x…": { name: "Asset Hub", role: "AssetHub", rpc: "wss://…" } },
  network: "paseo-next-v2",
  storageDir: "~/.my-cli/truapi",
});

const product = host.createProduct({ productId: "my-app.dot" });
const client = createClient(createTransport(product.provider));

// Drive login from the product side; the host renders the QR, the
// silent ~20s "Authenticating" window, and the session identity.
await client.account.requestLogin({ reason: "sign in to my-cli" });
```

`examples/pair.ts` is the runnable version (network and phone required).

### Wiring into `@parity/product-sdk-*`: via a TEST seam, knowingly

A product stack built on `@parity/product-sdk-host` reaches this host through
`setTruApiClient` from `@parity/product-sdk-host/testing`:

```ts
import { setTruApiClient } from "@parity/product-sdk-host/testing";
setTruApiClient(createClient(createTransport(product.provider)));
```

That entry point is **documented as test-only** upstream ("silently reroutes
every host accessor"). It is the only injection point that exists today; this
package uses it knowingly, and the supported seam should be shaped by real
consumers like this one before it is proposed upstream. Track the caveat, do
not hide it.

### papi consumers MUST wrap their provider

If the product side drives chains through polkadot-api over the core's
host-mediated provider, wrap it:

```ts
import { serializeOperationStarts } from "@dotli/host-cli";
const provider = serializeOperationStarts(rawProviderOverTheCore);
```

The chain-head relay can deliver an operation's events **before** the
start-response that names its `operationId`; papi drops such events silently
and the read never settles (measured: hung 3 runs in 6, with a 155-request
retry storm; 6/6 clean with the shim). This is load-bearing, not defensive.

## What the host owns beyond the callbacks

Each of these is a measured finding against the core, not a guess:

- **Pairing presentation.** The deeplink arrives via `AuthState.Pairing`
  before any socket opens, so the QR renders instantly and offline.
- **The silent `Authenticating` window.** The People-chain statement
  round-trip runs ~20s with no callback in between; the presenter shows
  elapsed progress so the host does not look hung.
- **Clearing product storage on logout.** Core product-storage keys are
  scoped by product id, NOT by account, so the next identity would inherit the
  previous one's data. `disconnectSession()` clears the store, and a
  different identity connecting clears it as a crash-safe backstop.
- **Pooling chain connections.** The core opens a socket per need (three
  People-chain sockets during pairing alone). The pool shares sockets per
  genesis hash with per-lease id rewriting, capped leases per socket (default
  2, below substrate's per-connection `chainHead_v1_follow` limit), and
  strictly order-preserving delivery.
- **Parked `theme`/`preimage` streams.** Both are emit-once-then-stay-open
  subscriptions; returning early reads as end-of-stream to the core.
- **Translating the SSO timeout.** A wallet that never answers yields a bare
  `TxError` after ~180s with no message; `explainProductError` turns it into
  "no response from your phone" guidance. The core's own diagnosis is only a
  `tracing` warning, which is why `logLevel` defaults to `warn`.

## Security model: the phone is the trust surface

`confirmUserAction` prompts are **deliberately modest**. The host cannot
decode what it approves: `CreateTransaction` carries opaque `callData`,
`PreimageSubmit` only a byte count. The paired wallet decodes and displays
the authoritative content before signing, so the terminal prompt states the
action kind, the typed metadata the host actually knows (account, chain,
sizes, the raw-bytes-vs-text discriminant of `SignRaw`), and defers the rest
to the phone. A prompt that pretended to summarize undecodable bytes would be
a false trust surface.

Two consequences to accept knowingly:

- **No unattended signing.** The core exposes no local keypair API; every
  signature needs the paired phone. There is no CI path.
- **Non-interactive terminals deny.** A host that cannot ask must not
  approve: prompts auto-deny when stdin is not a TTY.

## Known seams (candidate upstream asks for `@parity/truapi-host`)

- The typed-to-raw adapter (`createWasmRawCallbacks`) is not in the package's
  exports map; it is reached by **file URL** relative to the exported wasm
  path (`src/wasm.ts`). A `./node` export would remove this.
- The wasm is instantiated with `initSync` from bytes; the shipped Worker
  runtime is browser-only by construction, not necessity.

## Versioning and releases

This package versions **independently** of the dotli app (semver, starting
0.1.0; breaking host-API changes bump minor pre-1.0). It is excluded from the
repo's app-release version sync (`scripts/set-version.ts` skips published
packages). Releases are cut by tagging `host-cli-vX.Y.Z`, which builds,
tests, and publishes from CI. See `CHANGELOG.md`.
