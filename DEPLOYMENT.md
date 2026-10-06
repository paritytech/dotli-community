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
  the environment, and the CI config rollout passes the environment secrets of the same names. It pipes them over SSH
  into `/etc/nginx/dotli-private/<site>-media-turn.conf` (`root:root`, `0600`). The token is not in the rendered site
  config, `/tmp`, rsync uploads, the frontend build or the make log, and the route has access and error logging off.
- Set both secrets or neither. Unset, `deploy-nginx` warns and writes the file empty: the route answers 503 and calls
  cannot connect. Removing the secrets and redeploying disables the route.
- The token is the Cloudflare Realtime TURN key's API token (`Authorization: Bearer`), paired with that key's id. Rotate
  it by updating both secrets and rerunning the config rollout.

## Opt-in CI identity proxy rollout

CI normally uploads only the three frontend builds. To also deploy the existing NGINX template and identity proxy, set
the GitHub Actions **environment variable** `DEPLOY_NGINX=true` on the approved `dotli.dev`, `westendli.dev`, or
`paseo.fyi` environment. Each environment opts in independently; other matrix environments remain dist-only even if this
variable is set there. Deployment planning and triggers are unchanged. For `paseo.fyi`, use the existing feature PR
carrying `deploy: paseo.fyi`; its frontend and identity proxy share the same reviewed deployment revision. Only enable
config rollout for a reviewed deployment commit.

Only these environment-to-site mappings are accepted by `ci-deploy-nginx`:

| GitHub environment | Explicit Make argument | Required `DEPLOY_PATH` secret | Isolated snippet directory           |
| ------------------ | ---------------------- | ----------------------------- | ------------------------------------ |
| `dotli.dev`        | `ENV=dev-polkadot`     | `/var/www/dotlidev`           | `/etc/nginx/snippets/dotli.dev/`     |
| `westendli.dev`    | `ENV=dev-westend`      | `/var/www/westendlidev`       | `/etc/nginx/snippets/westendli.dev/` |
| `paseo.fyi`        | `ENV=fyi-paseo`        | `/var/www/paseofyi`           | `/etc/nginx/snippets/paseo.fyi/`     |

The selected environment must already be provisioned:

- `DEPLOY_HOST`, `DEPLOY_USER`, and `DEPLOY_SSH_KEY` secrets identify its existing SSH server and key. The user needs
  write access to `/tmp` and the frontend directories, plus passwordless sudo for installing NGINX files, running
  `nginx -t`, and reloading the service.
- `DEPLOY_PATH` must exactly match the selected environment's path above; its `host`, `app`, and `protocol` directories
  must already exist. The target rejects a mismatched path, an implicit `ENV`, or any other environment before uploading
  config. The workflow does this before uploading frontend files.
- DNS for the selected site, `*.<site>`, and `*.app.<site>` must reach this server, with the existing matching
  certificate under `/etc/letsencrypt/live/<site>/`. NGINX, its Brotli modules, and the template's DNS resolver at
  `127.0.0.53` must already be available.
- Keep the environment's configured `SENTRY_DSN` secret: CI forwards the same value used by the frontend build when
  rendering the `/t` tunnel. An unset secret disables that tunnel; do not omit an existing DSN for config rollout.
- Keep `DOTLI_TURN_CLOUDFLARE_KEY_ID` and `DOTLI_TURN_CLOUDFLARE_API_TOKEN` set as environment secrets wherever calls
  must connect: every config rollout rewrites the server's TURN include, and unset secrets disable the Media TURN route.
- The runner needs `make`, `envsubst` (gettext-base), `ssh`, `scp`, `rsync`, `curl`, and `jq`. This path does not
  provision packages or certificates.

The config-only commands used by CI are alternatives; run only the command for the approved environment:

```sh
# Export DEPLOY_USER, DEPLOY_HOST, DEPLOY_PATH, the configured SENTRY_DSN and the
# DOTLI_TURN_CLOUDFLARE_KEY_ID/DOTLI_TURN_CLOUDFLARE_API_TOKEN pair from the
# approved environment; load its SSH key and known_hosts first.
make ci-deploy-nginx ENV=dev-polkadot
# Or, for an independently approved westendli.dev rollout:
make ci-deploy-nginx ENV=dev-westend
# Or, for an independently approved paseo.fyi rollout:
make ci-deploy-nginx ENV=fyi-paseo
```

This delegates to `deploy-nginx` with the CI SSH destination, ignoring local `REMOTE` settings. It installs snippets
under the selected site's isolated directory above and rewrites both the site's and snippets' include paths to that
directory. Shared snippet files and other sites' isolated directories are not overwritten. The tradeoff is that each
opted-in site has its own snapshot: future shared snippet fixes must be rolled out to that site too. Keep using this CI
target to preserve isolation; plain `deploy-nginx` retains its shared-directory default. NGINX still validates and
reloads the whole server configuration. `nginx -t` must pass before reload; a failure leaves installed files for
operator repair but does not reload the running service. This is not an atomic rollback or a full provisioning path.

After frontend upload, the opted-in job performs a public read-only GET to

`https://<site>/__dotli-identity/paseo/attester`, matching its environment. It requires successful HTTP status and a
JSON object containing a 32-byte hex `attester`; frontend HTML with status 200 fails. No authentication challenge,
token, or username is created by the smoke check. When `DOTLI_TURN_CLOUDFLARE_KEY_ID` is set, the job also GETs
`https://<site>/__dotli-media/turn` and requires a credentialed `turn:`/`turns:` relay, printing only the verdict; this
mints one short-lived relay credential. Unset `DEPLOY_NGINX` to return to dist-only CI; this does not remove an already
installed proxy.

## Qualify and deploy Chat on paseo.fyi

Chat-specific browser integration belongs to `paritytech/dotli-community#255`, head `feat/chat-v2-host-runtime`, base
`feat/pvm-wasm`. Keep that base and forward changes through Seity #287 into the deploy integration #291,
`feat/jam-peer-transport-on-seity` (base `feat/chat-seity-profile`). Only #291 carries `deploy: paseo.fyi`; never put
that label on #238, #185, #255, #287, or #290. Updating these branches does not merge their feature PRs into their
bases.

Each browser layer must vendor a matching client/host package set from its corresponding native layer:

| Browser layer           | Native host source                                        |
| ----------------------- | --------------------------------------------------------- |
| #185 PolkaVM runtime    | `host-rust-core#540`, `feat/pvm-app-runtime`              |
| #255 Chat               | `host-rust-core#709`, `feat/chat-v2-product-authority`    |
| Media (on #255, no PR)  | `feat/media-sessions` on `host-rust-core#709`             |
| #287 Seity profiles     | `host-rust-core#1001`, `feat/chat-seity-profile`          |
| #290 JAM PeerTransport  | `host-rust-core#1010`, `feat/pvm-peer-transport`          |
| #291 Deploy integration | `host-rust-core#1011`, `feat/jam-peer-transport-on-seity` |
| Media integration       | `feat/media-on-jam-seity` (#1011 + `feat/media-sessions`) |

Keep #291 and native #1011 integration-only: merge their refreshed Seity and PeerTransport parents with `--no-ff`, then
refresh the matching vendored packages. Never copy Chat, Seity, PeerTransport, or Media APIs into a lower layer.

Before publishing the Chat layer:

1. Build `@parity/truapi` and `@parity/truapi-host` from the same committed `host-rust-core#709` source, including
   codegen and the browser WASM build. Version `0.17.0` alone is not proof of the method-12 native Chat actor API.
   Replace the two vendored package archives together, retain `@parity/truapi=file:../truapi` in the vendored host
   package, and update `vendor/truapi-host.lock.json` with the actual source and WASM revision, archive SHA-256 values,
   the hash of `vendor/truapi/dist/generated/client.js`, and the uncompressed
   `vendor/truapi-host/dist/wasm/web/truapi_server_bg.wasm` hash. If package dependency metadata changes, refresh
   `package-lock.json` with Node 26/npm 12 and `npm install`; otherwise retain the existing lock. Never invent pins.
2. Run the repository quality gate against the candidate head and verify the vendored generated client exposes
   `account.deviceChat` (method 12), `MainPurseChatPayment` review, private storage slots through `NativeChatProducts`,
   and per-product platform callbacks on the shared signing runtime. The independent PolkaVM renderer/runtime asset lock
   is not a substitute for the Host WASM pin.
3. Use a debug build with `VITE_NETWORKS=paseo-next-v2`. Confirm People genesis
   `0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48`, Coinage instance `0` (`pUSD`, six chain
   decimals), and bare identity suffix `paseo`. Inspect the configured chain metadata rather than inferring an asset
   from a UI name. The browser uses the inherited experimental wallet, not a product-owned wallet; it does not claim
   hardware-backed spending approval.
4. In the actual browser surface, qualify invitation/acceptance, text and attachments, then a rejected payment. Every
   spend must show the exact requesting product, recipient identity, amount, maximum debit, chain, asset instance and
   operation. A prior Chat grant must not skip this review. Only an explicitly authorized real-funds exercise may
   approve a payment; check actual settlement in both directions, not merely a sent message.
5. Close the product connection while keeping the page core's wallet lease open; receive in the background. Products and
   host controls lease the same native core; changing the page product retires the old signing authority before
   acquiring its replacement. Reload and verify authorized native Chat devices resume without prompting. Verify pending
   payments reconcile rather than being displayed as cleared. Move the wallet to a competing tab: the former owner must
   stop its worker and release custody before the new tab can sign. Concurrent custody attempts must fail unavailable,
   not create a second signer or overwrite inventory. Test storage/crypto failures in an isolated profile, never by
   clearing an existing wallet's storage. The wallet owner is exclusive across host subdomains/tabs. Private core
   records are authenticated-encrypted in the root-origin store; immutable attachment source Blobs remain host-private
   but are not encrypted at rest, matching the SDK source store's existing policy.

After qualifying each source layer, forward both #287 and #290 into #291 and rebuild its matching native #1011 package
set. Run the quality gate and browser qualification again on the final #291 candidate. Verify the repository, PR number,
head, base, vendor provenance, and deployment label before publishing the approved candidate to **#291's existing head
branch**. Its `pull_request/synchronize` event selects `paseo.fyi` from that label and deploys the PR head SHA after the
quality gate. Confirm that no other deployment label is present before triggering a synchronization. Observe both
published-product and TrUAPI smoke jobs, then repeat the Chat surface checks on paseo.fyi with the separately qualified,
payment-capable `echat.paseo` product release. An older `egui-chat` build is not a substitute for the current product or
evidence that payments work.

Do not use `workflow_dispatch` for this operation: this workflow routes manual dispatch to **westendli.dev**, not
paseo.fyi. Do not fall back to another environment if paseo.fyi qualification or deployment fails. The wallet's
same-origin identity proxy must already be configured, or its separately authorized `DEPLOY_NGINX` opt-in must target
`fyi-paseo` as documented above.

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
`RECEIVING_VAPID_PUBLIC_KEY`; the workflow passes them to the corresponding `VITE_*` build settings. Enable
`DEPLOY_NGINX` so the same deployment installs the generated worker CSP into its site-isolated snippet directory.
Dist-only upload does not update nginx policy.

For a loopback relay exposed at the configured product origin's `/__receiving`, also set `RECEIVING_PROXY_PORT` to its
listening port. The nginx deployment requires the matching generated CSP and an HTTPS product subdomain of the
deployment site. Only that exact hostname can reach the relay; other product hosts receive 404. The relay owns CORS, and
receiving request paths are excluded from nginx access logs. With no proxy port, `/__receiving/` returns 404. The relay
and its persistent private keys/database must already be provisioned; the frontend workflow never creates or rotates
provider credentials.

The vendored `@parity/truapi-host` JS, generated bindings, and PVM web WASM must have compatible receiving-enabled
contracts and exact recorded source provenance. Required exports are `browser-receiving-worker` and
`WasmNotificationReceiver` from `wasm/web`. This top integration vendors both SDK archives and both WASM bundles from
native `feat/media-on-jam-seity` `674e9a8a17b3916b1eaf99a53baa71a73b2fb115` (trinity-user-agents #1217), the Media layer
merged into #1011 integration revision `e4d0a15b5b74e7636ac50f2ee1563bf734c54c81`. Archive and generated client/WASM
checksums are recorded in `vendor/truapi-host.lock.json`; the only package override is the host SDK's local
`@parity/truapi` dependency. A clean #185-based receiving distribution needs its own SDK without Chat/Seity/Jam; never
reuse this top integration artifact downward. The build bundles `host-receiving.js` as a standalone classic IIFE and
copies that SDK's WASM to a content-hashed, same-origin `assets/receiving-<sha256>.wasm`. No dynamic imports or second
service-worker registration are used. The canonical installer owns callback SCALE adaptation. Workbox imports this
bundle into `/host-sw.js`, retains its existing precache rules and prompted update behavior, and precaches the matching
WASM. Deploy the complete host output together, not a worker or WASM file in isolation.

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
