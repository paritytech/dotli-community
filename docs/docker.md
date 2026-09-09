---
summary: "The prebuilt dotli artifacts — container image and release tarball — each repointed at a forked dev chain per run without rebuilding"
read_when:
  - You want to run dotli against a locally forked chain (zombie-bite, chopsticks)
  - You are changing the runtime network config schema or how it reaches the browser
  - You are editing nginx/nginx.docker.conf.template, docker/entrypoint.sh or scripts/serve.ts
  - You need to know why runtime config is off in the hosted deployments
title: "Prebuilt bundles"
---

Every release publishes two prebuilt artifacts, so a forked chain can be browsed
without building anything:

| Artifact | Server | Needs |
| --- | --- | --- |
| `ghcr.io/paritytech/dotli-community:<version>` | nginx | Docker |
| `dotli-<version>.tar.gz` on the GitHub release | `serve.mjs` | node >= 22 or bun |

Both serve all three builds on a single port and take their network configuration
**at run time** from the same `$DOTLI_NETWORK`, so a fork config is portable
between them and one artifact works against any chain. This page covers how to use
them and why they are built the way they are.

## Running the tarball

```sh
tar xzf dotli-0.7.4.tar.gz && cd dotli-0.7.4
DOTLI_NETWORK='{"enabled":["previewnet"]}' node serve.mjs   # or: bun serve.mjs
```

Then open `http://browse.localhost:5173`. `PORT`, `HOST` and `DIST` are
configurable — see the README inside the tarball
(`scripts/tarball-readme.md` in this repo).

`serve.mjs` is bundled from `scripts/serve.ts` at release time, because node
cannot execute TypeScript. It reproduces the nginx serving rules: hostname
routing, the same security headers, precompressed siblings, immutable asset
caching and SPA fallback. **Changing the rules in one means changing the other** —
nothing enforces it, and a mismatch means the tarball behaves differently from a
deployed site.

## Running the container

Build once, with no arguments:

```sh
docker build -t dotli .
```

Configure per run. Three modes, first match wins:

```sh
# 1. Built-in networks
docker run -p 5173:5173 dotli

# 2. Inline JSON
docker run -p 5173:5173 \
  -e DOTLI_NETWORK='{"enabled":["paseo-next-v2"],
                     "networks":{"paseo-next-v2":{"label":"My Fork",
                       "assethub":{"rpcs":["ws://host.docker.internal:9944"]}}}}' \
  dotli

# 3. Mounted file
docker run -p 5173:5173 -v ./network.json:/etc/dotli/network.json dotli
```

Then open `http://localhost:5173`.

The container logs the effective config on startup, which is how you confirm an
override applied without opening a browser. A config it cannot make sense of
stops the container rather than starting with the override silently dropped.

## Config schema

`RuntimeNetworkConfig` in `packages/config/src/network.ts` is the source of
truth. Two top-level keys, both optional:

| Key | Effect |
|---|---|
| `enabled` | Networks offered in the Settings selector. Replaces `VITE_NETWORKS`. First entry is the default. |
| `networks` | Per-network patches, keyed by `NetworkName`, merged over the built-in entry. |
| `baseDomain` | Explicit base domain, for hosts with more than two segments. See below. |

Only **endpoints** are overridable, per network:

| Field | Overridable | Notes |
|---|---|---|
| `label`, `rpcs`, `ipfsGateways` | yes | which node you talk to, and what it is called |
| `genesis`, `dotns` | **no** | the trust root for name resolution, fixed at build time |

Fixing `genesis` and `dotns` is what keeps this small and safe. An override cannot
repoint the DotNS registry, so the worst it can do is move you to a different node
for the *same* chain identity — which the light client verifies against the
compiled-in genesis anyway. It also means only documents need the config: the
protocol SharedWorker reads solely `genesis` and `dotns`, so nothing is plumbed to
it. A zombie-bite fork preserves both, so endpoints are the only axis that has to
move.

Two more rules:

**Patches existing networks, no new names**, so `NetworkName` stays a closed
union. Use `label` to say what a repointed network really is.

**Arrays replace, they do not concatenate.** `{"rpcs":["ws://localhost:9944"]}`
yields exactly one endpoint. Appending would leave your fork's endpoint in a pool
alongside the public ones, the client would pick whichever, and the result works
intermittently in a way that is very hard to diagnose.

**Mistakes fail loudly**, at container start where possible and at boot
otherwise — a silently ignored override means running against the public chain
while believing otherwise.

## Why `*.localhost` on one port

dotli needs four hostnames: an apex, `host.<domain>` for the protocol iframe,
`*.app.<domain>` for sandboxes, and `*.<domain>` for the shell. The container
serves them as `localhost`, `host.localhost`, `*.app.localhost`, `*.localhost`,
mirroring what `scripts/preview-server.ts` does for local previews.

This needs no code changes and no DNS setup: the flat `*.localhost` shape is
already special-cased in `getProtocolOrigin` (`packages/protocol/src/client.ts`),
`dotUrl` (`packages/ui/src/ui.ts`) and `getAppOrigin`
(`packages/ui/src/bridge.ts`), browsers resolve every `*.localhost` name to
loopback, and `http://*.localhost` is a secure context so `crypto.subtle`,
service workers and SharedWorker all work.

A custom dev domain would *not* work: `deriveBaseDomain` returns `"dot.li"` for
anything ending in `.localhost`, and `isSandboxOrigin` only recognises the flat
`.app.localhost` form, so a nested `foo.app.dotli.localhost` breaks. Use the flat
scheme or a real domain with a wildcard certificate — not a hybrid.

**Do not publish on port 80.** `getProtocolOrigin` falls back to port 5173 when
`window.location.port` is empty, which it is on the default HTTP port, so the
protocol iframe would be looked for on the wrong port. Any explicit port is fine;
the bundle reads the port from the current location.

## Base domain

dot.li needs four hostnames — an apex, `host.<base>`, `*.<base>` and
`*.app.<base>` — and normally derives `<base>` from the last two segments of the
current hostname. That is right for `dot.li` and `paseo.li` and wrong for anything
deeper: `dotli.ppn-65iw.pdp-stg-scw.parity.io` would derive `parity.io`, then look
for its protocol iframe at `host.parity.io` and accept `*.app.parity.io` as sandbox
origins.

Such hosts must state it:

```json
{ "baseDomain": "dotli.ppn-65iw.pdp-stg-scw.parity.io" }
```

Validated at boot: it must be at least two segments **and a suffix of the actual
hostname**, otherwise a page could declare any base domain and widen the
cross-origin allowlist to a host it is not served from. Set `DOMAIN` to the same
value so nginx renders matching `server_name`s and a matching `frame-ancestors`
list — the entrypoint derives the https origin triple from it, which is what makes
the image usable behind an ingress.

Note this also changes `SITE_ID`, and shared-auth storage is keyed on it, so
sessions do not carry between base domains.

Paths are not an alternative. Serving under `/dotli/…` would put all three builds
on one origin, and the subdomain split *is* the sandbox boundary — a dApp
same-origin with the shell can read its storage and skip every `postMessage` gate.
The `.dot` label is read from the subdomain, so a path-based URL would render the
landing page regardless.

## How config reaches the browser

Every reader of the network table is synchronous, so the config has to be in place
before the module bundle runs. A blocking classic `<script src="/dotli-network.js">`
sets `globalThis.__DOTLI_NETWORK__` ahead of the deferred bundle — the same trick
all three `index.html` files already use to pre-open IndexedDB. The table is then
built once at module init, with no async hydration anywhere.

The file does not exist in the image. `docker/entrypoint.sh` generates it at
container start and nginx serves it via `alias`
(`docker/dotli-runtime-network.conf`), included in every server block so the three
origins cannot disagree about which chain they are on. It is served `no-store` so
a restart takes effect immediately. Bypass the entrypoint
(`--entrypoint nginx`) and the file is absent, the tag 404s, and the built-ins
apply.

Outside the container the same path is served from `$DOTLI_NETWORK` by the vite
dev servers (via the plugin) and by `scripts/preview-server.ts`, so runtime config
is testable without building an image:

```sh
DOTLI_NETWORK='{"enabled":["previewnet"]}' bun run preview
```

## Why runtime config is off in the hosted deployments

Gated behind `VITE_RUNTIME_NETWORK_CONFIG`, set only in the `Dockerfile`. This is
a security boundary, not a convenience switch.

Overrides reach endpoints only, so the blast radius is already small. The reason
to gate it anyway is that a stable, documented hook into network configuration
that survives every release is cheaper to abuse than patching a hash-named
bundle, and the hosted deployments have no use for it. Both halves are gated
independently, so neither alone turns it on:

- `packages/config/src/runtime-network-config-plugin.ts` **injects** the script
  tag on opt-in rather than stripping it on opt-out, so the default is safe by
  construction: a default build's HTML is byte-identical to one from before
  runtime config existed.
- `RUNTIME_CONFIG_ENABLED` in `network.ts` gates the reader. In a default build
  the minifier folds the guard and `readRuntimeConfig()` compiles to
  `return null`, so the global read is absent rather than merely bypassed.

Inside the image the global **is** live and writable from the page. That is
acceptable for a local dev container — whoever runs it already controls
`DOTLI_NETWORK`, and `genesis`/`dotns` are out of reach either way — but treat the
image as local tooling rather than something to host publicly.

## Known gaps

**The smoldot backends ignore `rpcs`.** `smoldot-direct` and
`smoldot-shared-worker` (Light Client Per-Tab and Light Client Shared in the UI)
sync from chain specs, so an RPC override only takes effect under `rpc-gateway`
(Trusted Providers). A container pointed at a dead endpoint still looks healthy
under either smoldot backend.

**A smoldot backend against a fork can sync the wrong chain.** A zombie-bite fork
preserves the upstream genesis hash, and the committed chain specs carry
production bootnodes — so smoldot may peer with the real network and accept it as
correct while the UI names your fork. Genesis checks cannot catch this. Use
`rpc-gateway` against a fork, or supply a chain spec with bootnodes scrubbed.

**Mode preferences are not shared across subdomains.** `preview-server.ts`
implements a `/__dotli-mode/<key>` store to work around `localhost` being on the
Public Suffix List; nginx has no equivalent. `shared-mode.ts` prefers the
per-origin seed on localhost and only warns, so each subdomain simply keeps its
own backend and cache settings.

**No brotli.** `dotli-precompressed.conf` uses `brotli_static`, which the
official nginx image is not built with, so the image overwrites that snippet with
`gzip_static` alone. Precompressed `.gz` siblings still serve.

**Input and output share `/etc/dotli`.** Mounting the whole directory rather than
the single `network.json` means the generated files land in your host directory,
and a read-only mount makes the entrypoint's write fail.


## How releases are built

`.github/workflows/release-artifacts.yml` builds both artifacts on
`release: published`, and accepts a tag via `workflow_dispatch` for releases
published before it existed (a tag-triggered run cannot backfill one).

Two build settings are load-bearing, and the workflow asserts both rather than
trusting them:

- **`VITE_RUNTIME_NETWORK_CONFIG=true`** — without it the config script is not
  injected, and the server serves a config the app silently ignores. Everything
  looks fine while running against the public chain, which is the worst failure
  either artifact could ship. The job greps all three `index.html` files for the
  script tag.
- **`build:prod`, not `build`** — `compress-dist.ts` only runs there, so without it
  no `.br`/`.gz` siblings exist and the precompressed negotiation is dead code.
  The job checks for them.

The tarball is then smoke-tested under node before upload: three hostnames must
resolve to three distinct bundles, and `$DOTLI_NETWORK` must reach the served
config.

The image is built on native runners per architecture (`linux/amd64`,
`linux/arm64`) and joined into one manifest list. There is no macOS container
platform — Apple Silicon runs `linux/arm64`. `latest` only moves for a real,
non-prerelease publish, so backfilling an old tag by hand cannot repoint it.

## Related

- `nginx/nginx.docker.conf.template` — container nginx profile; sibling of
  `nginx/nginx.conf.template`, the deployed TLS profile. Keep the two in sync.
- `DEPLOYMENT.md` — the hosted deployments, which do not use any of this.
