# Deployment

One-shot provisioning of a fresh server using `make provision`. The target is idempotent and safe to re-run, so the same
command works for the first boot and for later top-ups.

## Requirements

### Remote server

- Ubuntu 24.04+ (Noble).
- The SSH user must have **passwordless `sudo`** — the provisioning steps run `sudo` non-interactively over SSH (no
  TTY), so a password prompt makes them fail. Either grant the user `NOPASSWD` sudo (e.g. a drop-in in
  `/etc/sudoers.d/`), or connect as `root` directly (`REMOTE=root@<ip>`).
- Reachable over SSH from your machine without a password (key-based auth).
- Public IP with ports `22`, `80`, and `443` open (the firewall step opens these via `ufw`).

### DNS

- The zone for the env's base domain (e.g. `paseo.li`) managed in Cloudflare.
- `A` / `AAAA` records pointing to the box for the apex.
- A Cloudflare API token scoped to **Zone → DNS → Edit** on that zone.

**Important:** The token needs to exist for all the time this is hosted as it will be required to renew the
certificates.

### Local machine

- `make`, `ssh`, `rsync`, and Node 26 with npm 12+.
- SSH agent loaded with the key the remote accepts (`ssh-add`).
- This repo checked out and on the branch/commit you want to deploy.

### Inputs you pass to the command

| Variable               | Required | Notes                                                                                                                                                                                               |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENV`                  | no       | One of `paseo`, `dev-paseo`, `fyi-paseo` (`paseo.fyi`), `dev-test` (`testnet.li`). Defaults to `paseo`.                                                                                             |
| `ADMIN_EMAIL`          | yes      | Let's Encrypt contact email.                                                                                                                                                                        |
| `CLOUDFLARE_API_TOKEN` | yes      | Cloudflare token with DNS edit on the zone.                                                                                                                                                         |
| `REMOTE`               | no       | `user@host` override. When unset, the target resolves from `REMOTE_PRD` / `REMOTE_STG` (see [Configure deploy targets](#configure-deploy-targets)). Pass this to deploy a box not covered by those. |
| `SENTRY_DSN`           | no       | Optional Sentry DSN (same value CI uses for `VITE_SENTRY_DSN`). `deploy-nginx` derives the `/t` tunnel proxy target from it. Can also live in `deploy.env`.                                         |

## Configure deploy targets

The production and staging SSH targets are not committed to the repo. Provide them in one of two ways:

- **`deploy.env`** (recommended for repeat deploys): copy `deploy.env.example` to `deploy.env` (gitignored) and set
  `REMOTE_PRD` / `REMOTE_STG`. The `Makefile` includes it automatically.
- **`REMOTE=user@host`** on the command line: overrides both for a single run, useful for a one-off or a brand-new box.

If neither is set, `make deploy` / `make provision` fails fast with a message telling you to configure a target. CI
deploys do not use these: the GitHub Actions path reads `DEPLOY_HOST` / `DEPLOY_USER` from repository secrets via the
`ci-deploy` target.

## What `make provision` does

`Makefile:81` chains these targets in order:

1. `provision-prereqs` — apt-installs nginx (with brotli modules), certbot, the Cloudflare DNS plugin, rsync, ufw, curl;
   removes the default nginx site.
2. `provision-firewall` — allows `OpenSSH` and `Nginx Full`, then enables `ufw`. SSH is whitelisted before enable so you
   don't lock yourself out.
3. `provision-cloudflare-creds` — writes `/etc/letsencrypt/cloudflare.ini` (`0600`, `root:root`) from the token you pass
   in.
4. `provision-cert` — issues a Let's Encrypt cert via DNS-01 covering the apex, `*.<base>`, and `*.app.<base>`.
   `--keep-until-expiring --expand` makes re-runs cheap.
5. `provision-renewal` — enables `certbot.timer` for auto-renewal.
6. `deploy` — runs `npm run build` on your machine `dist/` outputs into the env's web root.
7. `deploy-nginx` — renders `nginx/nginx.conf.template` for the env (envsubst) and installs it plus `nginx/snippets/`
   into `/etc/nginx/`, runs `nginx -t`, and reloads nginx. Preview the result with `make render-nginx ENV=<env>`.

## Run it

```sh
make provision \
  ENV=paseo \
  REMOTE=ubuntu@ip.for.machine \
  ADMIN_EMAIL=ops@example.com \
  CLOUDFLARE_API_TOKEN=cf_xxxxxxxxxxxxxxxxxxxxxxxxxxx
```

On success the last line is `Provisioning complete for ENV=<env>.` and the site is live at `https://<base-domain>`.

## Re-runs and follow-ups

- `make provision` is idempotent; re-run it to pick up nginx config or build changes.
- For code-only redeployments (no infra changes), `make deploy ENV=<env>` is enough.
- For nginx-only updates, `make deploy-nginx ENV=<env>`, or run the **Deploy nginx** workflow from the Actions tab: pick
  the environment and it runs the same target against that environment's box, behind that environment's protection
  rules. It deploys the config from the ref it was dispatched on, so `paseo.li` has to be dispatched from a release tag
  and `paseoli.dev` from `main`.

## Qualify and deploy Chat on paseo.fyi

Chat-specific browser integration belongs to `paritytech/dotli-community#255`, head `feat/chat-v2-host-runtime`, base
`feat/pvm-wasm` (#185, PolkaVM runtime on `main`). Forward changes through Seity #287 into #291
(`feat/jam-peer-transport-on-seity`), and from there into the umbrella #335, which alone carries `deploy: paseo.fyi`.
The wallet layer #367 (`feat/pwa-wallet`) sits on `main` beside this stack and reaches only #335. Never put the deploy
label on #185, #255, #287, #290, #291 or #367. Updating these branches does not merge their feature PRs into their
bases.

Each browser layer must vendor a matching client/host package set from its corresponding native layer:

| Browser layer           | Native host source                                        |
| ----------------------- | --------------------------------------------------------- |
| #185 PolkaVM runtime    | `host-rust-core#540`, `feat/pvm-app-runtime`              |
| #255 Chat               | `host-rust-core#709`, `feat/chat-v2-product-authority`    |
| #287 Seity profiles     | `host-rust-core#1001`, `feat/chat-seity-profile`          |
| #290 JAM PeerTransport  | `host-rust-core#1010`, `feat/pvm-peer-transport`          |
| #291 Deploy integration | `host-rust-core#1011`, `feat/jam-peer-transport-on-seity` |

Keep #291 and native #1011 integration-only: merge their refreshed Seity and PeerTransport parents with `--no-ff`, then
refresh the matching vendored packages. Never copy Chat, Seity, or PeerTransport APIs into a lower layer.

Before publishing the Chat layer:

1. Build `@parity/truapi` and `@parity/truapi-host` from the same committed `host-rust-core#709` source, including
   codegen and both Wasm bundles from the package's standard `build-wasm.mjs` (`wasm/web` for pairing, `wasm/testing`
   for the local wallet's signing worker). Replace the two vendored package archives together, retain
   `@parity/truapi=file:../truapi` in the vendored host package, and update `vendor/truapi-host.lock.json` with the
   actual source and Wasm revision, archive SHA-256 values, the hash of `vendor/truapi/dist/generated/client.js`, and
   both uncompressed `truapi_server_bg.wasm` hashes. If package dependency metadata changes, refresh `package-lock.json`
   with Node 26/npm 12; otherwise retain the existing lock. Never invent pins.
2. Run the repository quality gate against the candidate head and verify the vendored generated client exposes
   `account.deviceChat` (method 12), `MainPurseChatPayment` review, private storage slots through `NativeChatProducts`,
   and per-product platform callbacks on the shared signing runtime. The independent PolkaVM renderer/runtime asset lock
   is not a substitute for the Host Wasm pin.
3. Use a debug build with `VITE_NETWORKS=paseo-next-v2`. Confirm People genesis
   `0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48`, Coinage instance `0` (`pUSD`, six chain
   decimals), and bare identity suffix `paseo`. Native Chat runs on the debug panel's local wallet; it does not claim
   hardware-backed spending approval.
4. In the actual browser surface, qualify invitation/acceptance, text and attachments, then a rejected payment. Every
   spend must show the exact requesting product, recipient identity, amount, maximum debit, chain, asset instance and
   operation. A prior Chat grant must not skip this review. Only an explicitly authorized real-funds exercise may
   approve a payment; check actual settlement in both directions, not merely a sent message.
5. Close the product connection while keeping the page core open; receive in the background. Reload and verify
   authorized native Chat devices resume without prompting, and that pending payments reconcile rather than show as
   cleared. Open the same local wallet in a second tab: its Chat must fail as held elsewhere while the first tab keeps
   receiving, never run a second Chat signer or overwrite inventory. Test storage/crypto failures in an isolated
   profile, never by clearing an existing wallet's storage.

Verify the repository, PR number, head, base, vendor provenance, and deployment label before publishing the approved
candidate to #335's existing head branch. Its `pull_request/synchronize` event selects `paseo.fyi` from that label and
deploys the PR head SHA after the quality gate. Do not use `workflow_dispatch` for this operation: it routes to
**westendli.dev**, not paseo.fyi. Do not fall back to another environment if paseo.fyi qualification or deployment
fails.

## Checking what is deployed

Every origin serves its own build's `host_version.json` at the root:

```sh
curl -fsS https://paseo.li/host_version.json
# {"build":"host","version":"0.7.4","hash":"9f2c41e0…"}
```

`hash` is a SHA-256 of the build's output, so it changes whenever the bundle's contents do. It is written by the build
(`config/vite/src/build-info-plugin.ts`) and served `no-cache` (`nginx/snippets/dotli-host-version.conf`). The three
builds are rsynced separately, so check each origin to cover all of them:

| URL                                      | Build    |
| ---------------------------------------- | -------- |
| `https://<base>/host_version.json`       | host     |
| `https://host.<base>/host_version.json`  | protocol |
| `https://x.app.<base>/host_version.json` | app      |
