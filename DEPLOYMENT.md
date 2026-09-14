# Deployment

One-shot provisioning of a fresh server using `make provision`.
The target is idempotent and safe to re-run, so the same command
works for the first boot and for later top-ups.

## Requirements

### Remote server

- Ubuntu 24.04+ (Noble).
- The SSH user must have **passwordless `sudo`** — the provisioning steps run
  `sudo` non-interactively over SSH (no TTY), so a password prompt makes them
  fail. Either grant the user `NOPASSWD` sudo (e.g. a drop-in in
  `/etc/sudoers.d/`), or connect as `root` directly (`REMOTE=root@<ip>`).
- Reachable over SSH from your machine without a password (key-based auth).
- Public IP with ports `22`, `80`, and `443` open (the firewall step opens these via `ufw`).

### DNS

- The zone for the env's base domain (e.g. `paseo.li`) managed in Cloudflare.
- `A` / `AAAA` records pointing to the box for the apex.
- A Cloudflare API token scoped to **Zone → DNS → Edit** on that zone.

**Important:** The token needs to exist for all the time this is hosted as it will be required to renew the certificates.

### Local machine

- `make`, `ssh`, `rsync`, and [Bun](https://bun.sh) 1.3+.
- SSH agent loaded with the key the remote accepts (`ssh-add`).
- This repo checked out and on the branch/commit you want to deploy.

### Inputs you pass to the command

| Variable               | Required | Notes                                                                                                                                                                                               |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENV`                  | no       | One of `paseo`, `dev-paseo`, `dev-test`, `westend`, `dev-westend`, `dev-polkadot`. Defaults to `paseo`.                                                                                             |
| `ADMIN_EMAIL`          | yes      | Let's Encrypt contact email.                                                                                                                                                                        |
| `CLOUDFLARE_API_TOKEN` | yes      | Cloudflare token with DNS edit on the zone.                                                                                                                                                         |
| `REMOTE`               | no       | `user@host` override. When unset, the target resolves from `REMOTE_PRD` / `REMOTE_STG` (see [Configure deploy targets](#configure-deploy-targets)). Pass this to deploy a box not covered by those. |
| `SENTRY_DSN`           | no       | Optional Sentry DSN (same value CI uses for `VITE_SENTRY_DSN`). `deploy-nginx` derives the `/t` tunnel proxy target from it. Can also live in `deploy.env`.                                         |

## Configure deploy targets

The production and staging SSH targets are not committed to the repo. Provide
them in one of two ways:

- **`deploy.env`** (recommended for repeat deploys): copy `deploy.env.example`
  to `deploy.env` (gitignored) and set `REMOTE_PRD` / `REMOTE_STG`. The
  `Makefile` includes it automatically.
- **`REMOTE=user@host`** on the command line: overrides both for a single run,
  useful for a one-off or a brand-new box.

If neither is set, `make deploy` / `make provision` fails fast with a message
telling you to configure a target. CI deploys do not use these: the GitHub
Actions path reads `DEPLOY_HOST` / `DEPLOY_USER` from repository secrets via the
`ci-deploy` target.

## What `make provision` does

`Makefile:81` chains these targets in order:

1. `provision-prereqs` — apt-installs nginx (with brotli modules), certbot,
   the Cloudflare DNS plugin, rsync, ufw, curl; removes the default
   nginx site.
2. `provision-firewall` — allows `OpenSSH` and `Nginx Full`, then enables
   `ufw`. SSH is whitelisted before enable so you don't lock yourself out.
3. `provision-cloudflare-creds` — writes `/etc/letsencrypt/cloudflare.ini`
   (`0600`, `root:root`) from the token you pass in.
4. `provision-cert` — issues a Let's Encrypt cert via DNS-01 covering the
   apex, `*.<base>`, and `*.app.<base>`. `--keep-until-expiring --expand`
   makes re-runs cheap.
5. `provision-renewal` — enables `certbot.timer` for auto-renewal.
6. `deploy` — runs `bun run build` on your machine
   `dist/` outputs into the env's web root.
7. `deploy-nginx` — renders `nginx/nginx.conf.template` for the env (envsubst)
   and installs it plus `nginx/snippets/` into `/etc/nginx/`, runs `nginx -t`,
   and reloads nginx. Preview the result with `make render-nginx ENV=<env>`.

## Run it

```sh
make provision \
  ENV=paseo \
  REMOTE=ubuntu@ip.for.machine \
  ADMIN_EMAIL=ops@example.com \
  CLOUDFLARE_API_TOKEN=cf_xxxxxxxxxxxxxxxxxxxxxxxxxxx
```

On success the last line is `Provisioning complete for ENV=<env>.` and the
site is live at `https://<base-domain>`.

## Re-runs and follow-ups

- `make provision` is idempotent; re-run it to pick up nginx config or build changes.
- For code-only redeployments (no infra changes), `make deploy ENV=<env>` is enough.
- For nginx-only updates, `make deploy-nginx ENV=<env>`.

## Opt-in CI identity proxy rollout (westendli.dev)

CI normally uploads only the three frontend builds. To also deploy the existing
NGINX template and identity proxy, set the GitHub Actions **environment variable**
`DEPLOY_NGINX=true` on the `westendli.dev` environment. Other matrix environments
remain dist-only even if this variable is set there. Deployment planning and
triggers are unchanged: apply the `deploy: westendli.dev` PR label, or push to a
PR already carrying it. Only enable this for a reviewed deployment commit.

The environment must already be provisioned:

- `DEPLOY_HOST`, `DEPLOY_USER`, and `DEPLOY_SSH_KEY` secrets identify its existing
  SSH server and key. The user needs write access to `/tmp` and the frontend
  directories, plus passwordless sudo for installing NGINX files, running
  `nginx -t`, and reloading the service.
- `DEPLOY_PATH` must be exactly `/var/www/westendlidev`; its `host`, `app`, and
  `protocol` directories must already exist. The target rejects a mismatched
  path or anything other than an explicit command-line `ENV=dev-westend` before
  uploading config. The workflow does this before uploading frontend files.
- DNS for `westendli.dev`, `*.westendli.dev`, and `*.app.westendli.dev` must reach
  this server, with the existing matching certificate under
  `/etc/letsencrypt/live/westendli.dev/`. NGINX, its Brotli modules, and the
  template's DNS resolver at `127.0.0.53` must already be available.
- Keep the environment's configured `SENTRY_DSN` secret: CI forwards the same
  value used by the frontend build when rendering the `/t` tunnel. An unset
  secret disables that tunnel; do not omit an existing DSN for config rollout.
- The runner needs `make`, `envsubst` (gettext-base), `ssh`, `scp`, `rsync`,
  `curl`, and `jq`. This path does not provision packages or certificates.

The exact config-only command used by CI is:

```sh
# Export DEPLOY_USER, DEPLOY_HOST, DEPLOY_PATH, and the configured SENTRY_DSN
# from the approved environment; load its SSH key and known_hosts first.
make ci-deploy-nginx ENV=dev-westend
```

This delegates to `deploy-nginx` with the CI SSH destination, ignoring local
`REMOTE` settings. It installs snippets under
`/etc/nginx/snippets/westendli.dev/` and rewrites both the site's and snippets'
include paths to that directory. Shared snippet files used by sibling sites
are not overwritten. The tradeoff is that this site now has its own snapshot:
future shared snippet fixes must be rolled out here too. Keep using this CI
target to preserve isolation; plain `deploy-nginx` retains its shared-directory
default. NGINX still validates and reloads the whole server configuration.
`nginx -t` must pass before reload; a failure leaves installed files for operator
repair but does not reload the running service. This is not an atomic rollback
or a full provisioning path.

After frontend upload, the opted-in job performs a public read-only GET to
`https://westendli.dev/__dotli-identity/paseo/attester`. It requires successful
HTTP status and a JSON object containing a 32-byte hex `attester`; frontend HTML
with status 200 fails. No authentication challenge, token, or username is
created by the smoke check. Unset `DEPLOY_NGINX` to return to dist-only CI;
this does not remove an already installed proxy.
