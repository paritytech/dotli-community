# Deployment

One-shot provisioning of a fresh server using `make provision`.
The target is idempotent and safe to re-run, so the same command
works for the first boot and for later top-ups.

## Requirements

### Remote server

- Ubuntu 24.04+ (Noble) with `sudo` for the SSH user.
- Reachable over SSH from your machine without a password (key-based auth).
- Public IP with ports `22`, `80`, and `443` open (the firewall step opens these via `ufw`).

### DNS

- The zone for the env's base domain (e.g. `dot.li`) managed in Cloudflare.
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
| `ENV`                  | no       | One of `polkadot`, `dev-polkadot`, `paseo`, `dev-paseo`, `dev-test`, `westend`, `dev-westend`. Defaults to `polkadot`                                                                               |
| `ADMIN_EMAIL`          | yes      | Let's Encrypt contact email.                                                                                                                                                                        |
| `CLOUDFLARE_API_TOKEN` | yes      | Cloudflare token with DNS edit on the zone.                                                                                                                                                         |
| `REMOTE`               | no       | `user@host` override. When unset, the target resolves from `REMOTE_PRD` / `REMOTE_STG` (see [Configure deploy targets](#configure-deploy-targets)). Pass this to deploy a box not covered by those. |

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
7. `deploy-nginx` — installs `nginx/snippets/` and `nginx/nginx.<env>` into
   `/etc/nginx/`, runs `nginx -t`, and reloads nginx.

## Run it

```sh
make provision \
  ENV=polkadot \
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
