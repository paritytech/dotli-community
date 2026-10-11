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
  rules. It deploys the config from the ref it was dispatched on, so `paseo.li` has to be dispatched from a release tag
  and `paseoli.dev` from `main`.

## Identity proxy

The experimental local wallet checks and claims Lite usernames through a same-origin proxy, `/__dotli-identity/paseo`
and `/__dotli-identity/testnet`, which `nginx/snippets/dotli-identity-proxy.conf` forwards to `identity.dotspark.app`
and `identity-previewnet.dotspark.app`. Only public account proofs pass through; wallet entropy never leaves the
browser. The template includes it on the apex and product shell servers; the protocol (`host.`) and sandbox (`*.app.`)
servers answer 404. It accepts a fixed route, method and header set, only same-origin callers, and forwards no cookies,
redirects, CORS or caching headers. The template's resolver is systemd-resolved at `127.0.0.53`, the Ubuntu default, and
upstream TLS is verified against the `ca-certificates` roots that `provision-prereqs` installs.

### Opt-in CI rollout

CI normally uploads only the three frontend builds. To also deploy the nginx template and identity proxy with the same
revision as the frontend, set the GitHub Actions **environment variable** `DEPLOY_NGINX=true` on the `paseoli.dev` or
`paseo.fyi` environment. Each environment opts in independently; other environments stay dist-only even if the variable
is set there. Deployment planning and triggers are unchanged. Enable it only for reviewed deployment commits.

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

The config-only command CI runs, with `DEPLOY_USER`, `DEPLOY_HOST`, `DEPLOY_PATH` and `SENTRY_DSN` exported from the
approved environment and its SSH key loaded:

```sh
make ci-deploy-nginx ENV=fyi-paseo   # or ENV=dev-paseo
```

It delegates to `deploy-nginx` with the CI SSH destination, ignoring local `REMOTE` settings, and installs the snippets
under the site's isolated directory, rewriting both the site's and the snippets' include paths to it. Shared snippets
and other sites' directories on the box are left alone, so each opted-in site keeps its own snapshot: later shared
snippet fixes reach it only through this target. Plain `deploy-nginx` and the **Deploy nginx** workflow keep the shared
`/etc/nginx/snippets/` and re-render the site to point there. nginx still validates and reloads the whole server
configuration; if `nginx -t` fails, the installed files stay for operator repair and the running service is not
reloaded. This is not an atomic rollback.

After the frontend upload, the opted-in job sends a read-only GET to `https://<site>/__dotli-identity/paseo/attester`
and requires a JSON object whose `attester` is a 32-byte hex string, so a frontend HTML page with status 200 fails. It
creates no challenge, token or username. Unsetting `DEPLOY_NGINX` returns to dist-only CI; it does not remove an
installed proxy.

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
