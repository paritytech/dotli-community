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
   into `/etc/nginx/`, runs `nginx -t`, and reloads nginx. Preview the result with `make render-nginx ENV=<env>`. The
   rendered site includes the identity proxy (see [Identity proxy](#identity-proxy)).

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
  rules. It deploys the config from the ref it was dispatched on, so `paseo.li` has to be dispatched from a release tag.
  The workflow offers only `paseo.li` and `testnet.li`: `paseoli.dev` and `paseo.fyi` get their nginx config only
  through the [opt-in CI rollout](#opt-in-ci-nginx-rollout), which a shared-directory deploy would overwrite.

## Media TURN credentials

Host Media calls are relay-only and need TURN. NGINX serves `GET /__dotli-media/turn` on the apex and shell (`*.<site>`)
servers only (`nginx/snippets/dotli-media-turn.conf`); the app and protocol servers answer 404. Each request mints
12-hour Cloudflare TURN credentials: NGINX adds the API token and a fixed `{"ttl":43200}` body and posts to
`https://rtc.live.cloudflare.com/v1/turn/keys/<key id>/credentials/generate`. The shell reuses them for two thirds of
that lifetime. Nothing is baked into the frontend build, so credentials never go stale and no periodic redeploy is
needed.

- The route accepts same-origin browser requests only (no or matching `Origin`, `Sec-Fetch-Site` empty, `same-origin` or
  `none`), `GET` without a query. Responses are `Cache-Control: no-store` and
  `Cross-Origin-Resource-Policy: same-origin`. Each client IP gets 6 requests per minute (burst 10); excess gets 429.
  Non-browser clients can still mint relay credentials; the per-IP limit bounds that.
- `make deploy-nginx` reads `DOTLI_TURN_CLOUDFLARE_KEY_ID` and `DOTLI_TURN_CLOUDFLARE_API_TOKEN` from `deploy.env` or
  the environment, and the [opt-in CI nginx rollout](#opt-in-ci-nginx-rollout) passes the environment secrets of the
  same names. It pipes them over SSH into `/etc/nginx/dotli-private/<site>-media-turn.conf` (`root:root`, `0600`). The
  token is not in the rendered site config, `/tmp`, rsync uploads, the frontend build or the make log, and the route has
  access and error logging off.
- Set both secrets or neither. Unset, `deploy-nginx` warns and writes the file empty: the route answers 503 and calls
  cannot connect. Removing the secrets and redeploying disables the route.
- The token is the Cloudflare Realtime TURN key's API token (`Authorization: Bearer`), paired with that key's id. Rotate
  it by updating both secrets and rerunning the config rollout.

## Media advertisement lookups over trusted RPC (temporary)

On the light client backends, Media sends its advertisement lookups (requests whose id starts with
`truapi:media-advertisement-lookup:`, statement subscribe/unsubscribe only) to the People chain's trusted RPC node,
because smoldot returns no stored statements in a subscription snapshot. No server configuration is involved: the
browser dials the same People RPC endpoint the Trusted Providers backend uses. That operator learns which callee
advertisement topics a caller looks up and when, and can withhold advertisements (calls then fail `NotConnected`, as
they do on the light client today); it cannot forge an endpoint. Mention this in release notes for any deploy carrying
it, and remove `packages/ui/src/host-callbacks/media-advertisement-lookup.ts` with its one use in `Chain.ts` once the
light client serves stored statements. See [README.md](README.md#protected-browser-media).

## Identity proxy

The experimental local wallet checks and claims Lite usernames through a same-origin proxy, `/__dotli-identity/paseo`
and `/__dotli-identity/testnet`, which `nginx/snippets/dotli-identity-proxy.conf` forwards to `identity.dotspark.app`
and `identity-previewnet.dotspark.app`. Only public account proofs pass through; wallet entropy never leaves the
browser. The template includes it on the apex and product shell servers; the protocol (`host.`) and sandbox (`*.app.`)
servers answer 404. It accepts a fixed route, method and header set, only same-origin callers, and forwards no cookies,
redirects, CORS or caching headers. The template's resolver is systemd-resolved at `127.0.0.53`, the Ubuntu default, and
upstream TLS is verified against the `ca-certificates` roots that `provision-prereqs` installs.

## Opt-in CI nginx rollout

CI normally uploads only the three frontend builds. To also deploy the nginx config with the same revision as the
frontend, set the GitHub Actions **environment variable** `DEPLOY_NGINX=true` on the `paseoli.dev` or `paseo.fyi`
environment. Each environment opts in independently; other environments stay dist-only even if the variable is set
there. Deployment planning and triggers are unchanged. Enable it only for reviewed deployment commits.

This one **Deploy nginx config** step renders the whole site config from `nginx/nginx.conf.template`: the identity proxy
above, the [Media TURN route](#media-turn-credentials) with its private include, the
[receiving worker CSP and relay proxy](#optional-browser-background-receiving) when `RECEIVING_RELAY_URL` (and
`RECEIVING_PROXY_PORT`) are set, and the shared snippets (assets, service workers, Sentry tunnel). It runs after the
frontend build, whose generated `host-receiving-csp.conf` it installs, and before the frontend upload.

Only these environment-to-site mappings are accepted by `ci-deploy-nginx`:

| GitHub environment | Explicit Make argument | Required `DEPLOY_PATH` secret | Isolated snippet directory         |
| ------------------ | ---------------------- | ----------------------------- | ---------------------------------- |
| `paseoli.dev`      | `ENV=dev-paseo`        | `/var/www/paseolidev`         | `/etc/nginx/snippets/paseoli.dev/` |
| `paseo.fyi`        | `ENV=fyi-paseo`        | `/var/www/paseofyi`           | `/etc/nginx/snippets/paseo.fyi/`   |

The selected environment must already be provisioned:

- `DEPLOY_HOST`, `DEPLOY_USER`, and `DEPLOY_SSH_KEY` identify its SSH server and key. The user needs write access to
  `/tmp` and the frontend directories, plus passwordless sudo for installing nginx files, running `nginx -t`, and
  reloading the service.
- `DEPLOY_PATH` must exactly match the path above. The target rejects a mismatched path, an implicit `ENV`, or any other
  environment before uploading config, and the workflow runs it before uploading frontend files.
- DNS and the certificate for the site, `*.<site>`, and `*.app.<site>` must already be in place, as must nginx with its
  Brotli modules and the resolver at `127.0.0.53`.
- Keep the environment's `SENTRY_DSN` secret: CI forwards the value the frontend build uses to render the `/t` tunnel.
  An unset secret disables the tunnel.
- Keep `DOTLI_TURN_CLOUDFLARE_KEY_ID` and `DOTLI_TURN_CLOUDFLARE_API_TOKEN` set as environment secrets wherever calls
  must connect: every rollout rewrites the server's TURN include, and unset secrets disable the Media TURN route.
- Keep the `RECEIVING_*` variables set wherever receiving is deployed: a rollout without `RECEIVING_RELAY_URL` installs
  the empty worker CSP, and one without `RECEIVING_PROXY_PORT` makes `/__receiving/` answer 404.

The config-only command CI runs, with `DEPLOY_USER`, `DEPLOY_HOST`, `DEPLOY_PATH`, `SENTRY_DSN`, the TURN secret pair
and the `RECEIVING_CSP_FILE`/`RECEIVING_PUSH_ORIGIN`/`RECEIVING_PROXY_PORT` values exported from the approved
environment and its SSH key loaded:

```sh
make ci-deploy-nginx ENV=fyi-paseo   # or ENV=dev-paseo
```

It delegates to `deploy-nginx` with the CI SSH destination, ignoring local `REMOTE` settings, and installs the snippets
under the site's isolated directory, rewriting both the site's and the snippets' include paths to it. Shared snippets
and other sites' directories on the box are left alone, so each opted-in site keeps its own snapshot: later shared
snippet fixes reach it only through this target. Plain `deploy-nginx` and the **Deploy nginx** workflow keep the shared
`/etc/nginx/snippets/` and re-render the site to point there, so do not use them for an opted-in site. nginx still
validates and reloads the whole server configuration; if `nginx -t` fails, the installed files stay for operator repair
and the running service is not reloaded. This is not an atomic rollback.

After the frontend upload, the opted-in job runs three smokes:

- Identity proxy: a read-only GET to `https://<site>/__dotli-identity/paseo/attester` must return a JSON object whose
  `attester` is a 32-byte hex string, so a frontend HTML page with status 200 fails. It creates no challenge, token or
  username.
- Media TURN: when `DOTLI_TURN_CLOUDFLARE_KEY_ID` is set, a GET to `https://<site>/__dotli-media/turn` must return a
  credentialed `turn:`/`turns:` relay; only the verdict is printed. This mints one short-lived relay credential.
- Receiving: when `RECEIVING_RELAY_URL` and `RECEIVING_PROXY_PORT` are set,
  `<RECEIVING_PUSH_ORIGIN>/__receiving/healthz` must answer `{"ok":true}` through the proxy, and that host's
  `/host-sw.js` must carry the worker CSP naming the relay origin.

Unsetting `DEPLOY_NGINX` returns to dist-only CI; it does not remove an installed config.

## Qualify and deploy Chat on paseo.fyi

Chat-specific browser integration belongs to `paritytech/dotli-community#255`, head `feat/chat-v2-host-runtime`, base
`feat/pvm-wasm` (#185, PolkaVM runtime on `main`). Forward changes through Seity #287 into #291
(`feat/jam-peer-transport-on-seity`), and from there into the umbrella #335, which alone carries `deploy: paseo.fyi`.
The wallet layer #367 (`feat/pwa-wallet`) sits on `main` beside this stack and reaches only #335. Never put the deploy
label on #185, #255, #287, #290, #291 or #367. Updating these branches does not merge their feature PRs into their
bases.

Each browser layer must vendor a matching client/host package set from its corresponding native layer:

| Browser layer                     | Native host source                                        |
| --------------------------------- | --------------------------------------------------------- |
| #185 PolkaVM runtime              | `host-rust-core#540`, `feat/pvm-app-runtime`              |
| #255 Chat                         | `host-rust-core#709`, `feat/chat-v2-product-authority`    |
| Media (on #255)                   | `host-rust-core#1258`, `feat/media-sessions` (on #709)    |
| #287 Seity profiles               | `host-rust-core#1001`, `feat/chat-seity-profile`          |
| #290 JAM PeerTransport            | `host-rust-core#1010`, `feat/pvm-peer-transport`          |
| #291 Peer/Seity integration       | `host-rust-core#1011`, `feat/jam-peer-transport-on-seity` |
| #335 Media deployment integration | `host-rust-core#1217`, `feat/media-on-jam-seity`          |

Keep #291 and native #1011 integration-only: merge their refreshed Seity and PeerTransport parents with `--no-ff`, then
refresh the matching vendored packages. Never copy Chat, Seity, PeerTransport, or Media APIs into a lower layer.

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

## Optional browser background receiving

Receiving is host-owned and opt-in. It is unsupported when both build settings are absent; a partial configuration fails
the build. There is no default relay or provider credential:

```dotenv
VITE_RECEIVING_RELAY_URL=https://relay.example.org
VITE_RECEIVING_PUSH_ORIGIN=https://browser-smoke.receiving.test
VITE_RECEIVING_VAPID_PUBLIC_KEY=
```

These are illustrative addresses, not deployed services. Use the approved relay and product-subdomain host origins. Set
both variables for the host build (or leave both empty). URLs must use HTTPS without credentials, query strings, or
fragments. The push origin must equal the actual product host's `location.origin`, without a trailing slash, and the
relay's `PUSH_ORIGIN`. For the local HTTPS qualification route this is exactly `https://browser-smoke.receiving.test`,
not the root landing page `https://receiving.test`, the protocol iframe origin, or a `/product` path. The root landing
page does not expose the product host Settings. Configure the relay's allowed origin/product for that same route. The
relay must allow that origin through CORS and expose the canonical receiving transport endpoints. Set
`VITE_RECEIVING_VAPID_PUBLIC_KEY` to the relay operator's public base64url VAPID application-server key to enable
user-click Web Push enrollment. When omitted, enrollment reports an unsupported configuration; the key is not guessed or
fetched from an unrelated provider. Keep VAPID private keys and provider credentials on the relay; never put them in
`VITE_*`, product frames, or a notification payload. Existing build/deployment environments do not acquire these
settings automatically.

For GitHub deployments, set the environment-scoped `RECEIVING_RELAY_URL`, `RECEIVING_PUSH_ORIGIN`, and
`RECEIVING_VAPID_PUBLIC_KEY`; the workflow passes them to the corresponding `VITE_*` build settings. On `paseoli.dev` or
`paseo.fyi`, enable `DEPLOY_NGINX` so the same deployment's [nginx rollout](#opt-in-ci-nginx-rollout) installs the
worker CSP generated by that build. Other environments are dist-only in CI; their receiving nginx policy changes only
through `make deploy-nginx` with `RECEIVING_CSP_FILE` from the matching build. Dist-only upload does not update nginx
policy.

For a loopback relay exposed at the configured product origin's `/__receiving`, also set `RECEIVING_PROXY_PORT` to its
listening port. The nginx deployment requires the matching generated CSP and an HTTPS product subdomain of the
deployment site. Only that exact hostname can reach the relay; other product hosts receive 404. The relay owns CORS, and
receiving request paths are excluded from nginx access logs. With no proxy port, `/__receiving/` returns 404. The relay
and its persistent private keys/database must already be provisioned; the frontend workflow never creates or rotates
provider credentials.

The vendored `@parity/truapi-host` JS, generated bindings, and PVM web WASM must have compatible receiving-enabled
contracts and exact recorded source provenance. Required exports are `browser-receiving-worker` and
`WasmNotificationReceiver` from `wasm/web`. This top integration vendors both SDK archives and upstream's standard
`wasm/web` (runtime) and `wasm/testing` (local wallet signing worker) bundles from native #1217
`feat/media-on-jam-seity` at `70627ffb8fb64b3de99db2e37bf514f44f629542`. Archive and generated client/WASM checksums are
recorded in `vendor/truapi-host.lock.json`; the only package override is the host SDK's local `@parity/truapi`
dependency. A clean #185-based receiving distribution needs its own SDK without Chat/Seity/Jam; never reuse this top
integration artifact downward. The build bundles `host-receiving.js` as a standalone classic IIFE and copies that SDK's
WASM to a content-hashed, same-origin `assets/receiving-<sha256>.wasm`. No dynamic imports or second service-worker
registration are used. The canonical installer owns callback SCALE adaptation. Workbox imports this bundle into
`/host-sw.js`, retains its existing precache rules and prompted update behavior, and precaches the matching WASM. Deploy
the complete host output together, not a worker or WASM file in isolation.

For CSP-enforcing hosting, the build also emits `host-receiving-csp.conf`, an nginx `add_header` directive with the
exact relay origin. `deploy-nginx` installs this file as the site-specific `dotli-receiving-csp.conf` when
`RECEIVING_CSP_FILE` is set; `/host-sw.js` includes it alongside its existing headers. The CI workflow sets this path
from the matching configured host build. An unconfigured nginx deployment reinstalls the empty policy rather than
retaining an old relay. It permits only same-origin scripts, WASM compilation (`'wasm-unsafe-eval'`), and connections to
self/the configured relay. Install the matching policy whenever the relay changes; do not copy a policy between
environments. If an existing page CSP is enforced by a proxy, preserve its other directives while permitting
`worker-src 'self'` and the configured relay in `connect-src`. HTML meta policies do not set a service worker's CSP.
Static hosting other than nginx must translate the generated policy into the `/host-sw.js` response header.

Receiving requires HTTPS, service workers, Push API, Notifications, IndexedDB, and Web Locks. A configured build still
requires separate host receiving consent and OS notification permission. A host-origin mismatch or unavailable Web Locks
leaves receiving unsupported without breaking Workbox shell updates. The host announces registration through
`dotli:receiving-registration`; late-mounting UI looks up that same registration instead of registering another worker.
Development servers do not install this production receiving worker: exercise receiving with a built host served over
the approved HTTPS origin.

The shell exposes **Background receiving** in Settings. Enabling Web Push must come from that button's user gesture; it
does not enroll products. Enrollment requires a separate trusted host consent prompt. Revoke all receiving disables the
durable registrations locally before any asynchronous relay synchronization. Explicit disconnect, wallet erase, network
replacement, and full reset use the same local-first fence. A full reset retains the receiver's durable revocation
ledger so pending remote deletions are not lost; ordinary product close, page close, and suspension do not erase consent
or enrollments.

Local Chromium qualification exercised the built host at `https://browser-smoke.receiving.test`: Settings enabled a real
provider subscription through the button, with exactly one root-scoped `/host-sw.js`; the receiving UI reported enabled
and the revoke control completed without browser errors. Notification permission was supplied through the isolated
browser's automation grant. This was host transport setup, not a verified product enrollment—the smoke product name was
intentionally not published. UI typechecking, 43 notification/session-storage tests and 45 host tests pass. Physical
mobile delivery and end-to-end activation in a deployed product remain separate qualification gates.

Only the native core's authenticated `identityAccountId` can select an account. The host independently runs the existing
CID content verifier, off the ordinary startup and messaging path, before using a validated SHA-256 root multihash as
the artifact identity. This applies equally to HTML and PolkaVM archives. URL/development products, unsupported CID
provenance, and missing authenticated identity report receiving unsupported. Product frames never supply receiving
authority. Each connection retains its initial account/artifact/environment snapshot and is fenced on host navigation or
account replacement.

Notification activation only focuses or opens the host-retained verified product descriptor in the already selected
unlocked account. It never unlocks, switches accounts, or follows a sender route as a URL. Once that execution is ready,
the shared worker queues the canonical notification Activation event for the product to consume.

### Publication and qualification gates

This is local source work, not a published SDK or an approved rollout. Before publication, record accessible source
revisions, archive hashes, and separate WASM provenance in the vendor lock; preserve the clean feature/integration
boundaries. Obtain explicit approval for the exact publication and deployment environment; a local successful build does
not authorize either.

After matching artifacts are available, run UI typechecks and receiving tests, then build with the exact
product-subdomain origin, relay URL, and public VAPID key. Qualify Settings enable/permission denial/revoke, explicit
product consent, authenticated account/artifact binding, account replacement fences, and the root-scoped `/host-sw.js`
on that origin. Demonstrate actual provider delivery with no open host page, deduplication, and safe activation after
readiness. Provider acceptance alone is not notification display; unsupported/unconfigured states and local-first
revocation during relay failure must remain visible. Do not infer mobile or fully-quit browser delivery from a worker
smoke test.

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
