# Force a valid UTF-8 locale on the remote. macOS Terminal exports
# LC_CTYPE=UTF-8 (not a recognized locale on Linux) and SSH forwards it via
# the default SendEnv LC_*; setting LC_ALL here overrides it everywhere.
export LC_ALL := C.UTF-8

# Deploy SSH targets are not committed. Set them in a gitignored deploy.env
# (copy deploy.env.example) or pass REMOTE=user@host on the command line. CI
# deploys read DEPLOY_HOST and DEPLOY_USER secrets via the ci-deploy target and
# do not use these.
-include deploy.env

REMOTE_PRD ?=
REMOTE_STG ?=

# env tag → site filename in /etc/nginx/sites-available/
SITE_polkadot      := dot.li
SITE_dev-polkadot  := dotli.dev
SITE_paseo         := paseo.li
SITE_dev-paseo     := paseoli.dev
SITE_dev-test      := testnet.li
SITE_westend       := westend.li
SITE_dev-westend   := westendli.dev

# env tag → remote (only polkadot is prod; the rest share the staging box)
REMOTE_FOR_polkadot      := $(REMOTE_PRD)
REMOTE_FOR_dev-polkadot  := $(REMOTE_STG)
REMOTE_FOR_paseo         := $(REMOTE_STG)
REMOTE_FOR_dev-paseo     := $(REMOTE_STG)
REMOTE_FOR_dev-test      := $(REMOTE_STG)
REMOTE_FOR_westend       := $(REMOTE_STG)
REMOTE_FOR_dev-westend   := $(REMOTE_STG)

# env tag → web root on the remote (matches the `root` directive in nginx.<env>)
DEPLOY_PATH_polkadot      := /var/www/dotli
DEPLOY_PATH_dev-polkadot  := /var/www/dotlidev
DEPLOY_PATH_paseo         := /var/www/paseoli
DEPLOY_PATH_dev-paseo     := /var/www/paseolidev
DEPLOY_PATH_dev-test      := /var/www/testnetli
DEPLOY_PATH_westend       := /var/www/westendli
DEPLOY_PATH_dev-westend   := /var/www/westendlidev

# One cert per env covering <base>, *.<base>, and *.app.<base>. The cert
# lands at /etc/letsencrypt/live/<base>/, matching ssl_certificate paths in
# every server block of nginx.<env>. host.<base> is covered by *.<base>.
CERT_DOMAINS_polkadot     := dot.li *.dot.li *.app.dot.li
CERT_DOMAINS_dev-polkadot := dotli.dev *.dotli.dev *.app.dotli.dev
CERT_DOMAINS_paseo        := paseo.li *.paseo.li *.app.paseo.li
CERT_DOMAINS_dev-paseo    := paseoli.dev *.paseoli.dev *.app.paseoli.dev
CERT_DOMAINS_dev-test     := testnet.li *.testnet.li *.app.testnet.li
CERT_DOMAINS_westend      := westend.li *.westend.li *.app.westend.li
CERT_DOMAINS_dev-westend  := westendli.dev *.westendli.dev *.app.westendli.dev

VALID_ENVS := polkadot dev-polkadot paseo dev-paseo dev-test westend dev-westend

# Default env when none is passed on the command line.
ENV ?= polkadot

# Packages required on a fresh Ubuntu 22.04+ box. The brotli module is split
# across two packages on noble (filter + static) and both ship a drop-in in
# /etc/nginx/modules-enabled/ so they auto-load. curl and ca-certificates
# back certbot's API calls.
APT_PACKAGES := nginx libnginx-mod-http-brotli-filter libnginx-mod-http-brotli-static certbot python3-certbot-dns-cloudflare rsync ufw curl ca-certificates

.PHONY: build provision provision-prereqs provision-firewall provision-cloudflare-creds provision-cert provision-renewal deploy ci-deploy deploy-nginx _require-env

build:
	bun run build

# ====================================================================
# Fresh-server provisioning. Idempotent; safe to re-run.
#
#   make provision ENV=<env> \
#                  ADMIN_EMAIL=<email> \
#                  CLOUDFLARE_API_TOKEN=<token> \
#                  [REMOTE=ubuntu@1.2.3.4]
#
# REMOTE defaults to the per-env mapping above; override when bringing up
# a brand-new box. ADMIN_EMAIL is the Let's Encrypt contact; the Cloudflare
# token needs DNS edit permission on the zone being certified.
# ====================================================================
provision: provision-prereqs provision-firewall provision-cloudflare-creds provision-cert provision-renewal deploy deploy-nginx
	@echo
	@echo "Provisioning complete for ENV=$(ENV)."

provision-prereqs: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'set -euo pipefail; \
		sudo DEBIAN_FRONTEND=noninteractive apt-get update -y; \
		sudo DEBIAN_FRONTEND=noninteractive apt-get install -y $(APT_PACKAGES); \
		sudo rm -f /etc/nginx/sites-enabled/default'

# OpenSSH allow runs first so we never lock ourselves out before enabling ufw.
provision-firewall: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'sudo ufw allow OpenSSH && sudo ufw allow "Nginx Full" && sudo ufw --force enable'

# Token is piped over SSH (never written locally); shows up only inside the
# remote `tee` invocation, which lasts a few ms.
provision-cloudflare-creds: _require-env
	@test -n "$(CLOUDFLARE_API_TOKEN)" || (echo "CLOUDFLARE_API_TOKEN not set"; exit 1)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	@printf 'dns_cloudflare_api_token = %s\n' '$(CLOUDFLARE_API_TOKEN)' | ssh $(REMOTE_TARGET) 'sudo install -d -m 0700 /etc/letsencrypt && sudo tee /etc/letsencrypt/cloudflare.ini > /dev/null && sudo chmod 600 /etc/letsencrypt/cloudflare.ini && sudo chown root:root /etc/letsencrypt/cloudflare.ini'

# --keep-until-expiring + --expand makes this safe to re-run; only re-issues
# if the cert is about to expire or the SAN list changed. --cert-name pins
# the live/<name>/ directory so it matches the nginx ssl_certificate paths.
provision-cert: _require-env
	@test -n "$(ADMIN_EMAIL)" || (echo "ADMIN_EMAIL not set"; exit 1)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval CERT_FLAGS := $(foreach d,$(CERT_DOMAINS_$(ENV)), -d '$(d)'))
	ssh $(REMOTE_TARGET) "sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini --dns-cloudflare-propagation-seconds 30 --non-interactive --agree-tos -m '$(ADMIN_EMAIL)' --keep-until-expiring --expand --cert-name $(SITE_$(ENV)) $(CERT_FLAGS)"

provision-renewal: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'sudo systemctl enable --now certbot.timer'

# ====================================================================
# Local-build deploy. The turbo build runs on this machine.
# then only the resulting dist directories
# are rsynced into the nginx-served paths on the remote.
# ====================================================================
deploy: _require-env build
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval REMOTE_PATH   := $(DEPLOY_PATH_$(ENV)))
	ssh $(REMOTE_TARGET) 'sudo install -d -m 0755 -o $$(whoami) -g $$(id -gn) $(REMOTE_PATH) $(REMOTE_PATH)/host $(REMOTE_PATH)/app $(REMOTE_PATH)/protocol'
	$(call _rsync_dist,$(REMOTE_TARGET),$(REMOTE_PATH))

deploy-nginx: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval SITE := $(SITE_$(ENV)))
	rsync -avz --delete nginx/snippets/ $(REMOTE_TARGET):/tmp/dotli-nginx-snippets/
	scp nginx/nginx.$(ENV) $(REMOTE_TARGET):/tmp/$(SITE).nginx
	ssh $(REMOTE_TARGET) 'sudo install -d -m 0755 /etc/nginx/snippets && sudo rsync -av /tmp/dotli-nginx-snippets/ /etc/nginx/snippets/ && sudo cp /tmp/$(SITE).nginx /etc/nginx/sites-available/$(SITE) && sudo ln -sf /etc/nginx/sites-available/$(SITE) /etc/nginx/sites-enabled/$(SITE) && sudo nginx -t && sudo systemctl reload nginx'

define _rsync_dist
rsync -avz --delete --filter='P /assets/' apps/host/dist/     $(1):$(2)/host/
rsync -avz --delete --filter='P /assets/' apps/sandbox/dist/  $(1):$(2)/app/
rsync -avz --delete --filter='P /assets/' apps/protocol/dist/ $(1):$(2)/protocol/
endef

# CI deploy: reads DEPLOY_USER/DEPLOY_HOST/DEPLOY_PATH from env
ci-deploy:
	@test -n "$(DEPLOY_USER)" || (echo "ci-deploy: DEPLOY_USER not set"; exit 1)
	@test -n "$(DEPLOY_HOST)" || (echo "ci-deploy: DEPLOY_HOST not set"; exit 1)
	@test -n "$(DEPLOY_PATH)" || (echo "ci-deploy: DEPLOY_PATH not set"; exit 1)
	$(call _rsync_dist,$(DEPLOY_USER)@$(DEPLOY_HOST),$(DEPLOY_PATH))
	ssh $(DEPLOY_USER)@$(DEPLOY_HOST) 'find $(DEPLOY_PATH)/*/assets/ -type f -mtime +7 -delete 2>/dev/null || true'

_require-env:
	@test -n "$(ENV)" || (echo "ENV not set. Use ENV=<$(subst $() ,|,$(VALID_ENVS))>"; exit 1)
	@test -n "$(DEPLOY_PATH_$(ENV))" || (echo "Unknown ENV: $(ENV). Valid: $(VALID_ENVS)"; exit 1)
	@test -n "$(or $(REMOTE),$(REMOTE_FOR_$(ENV)))" || (echo "No deploy target for ENV=$(ENV). Set REMOTE_PRD/REMOTE_STG in deploy.env (copy deploy.env.example) or pass REMOTE=user@host."; exit 1)
