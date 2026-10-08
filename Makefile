# macOS Terminal exports LC_CTYPE=UTF-8, which Linux does not recognize, and SSH forwards it to the remote.
export LC_ALL := C.UTF-8

# Deploy targets are not committed. Copy deploy.env.example or pass REMOTE=user@host. CI uses ci-deploy instead.
-include deploy.env

REMOTE_PRD ?=
REMOTE_STG ?=

# Site filename in /etc/nginx/sites-available/
SITE_polkadot      := dot.li
SITE_paseo         := paseo.li
SITE_dev-paseo     := paseoli.dev
SITE_fyi-paseo     := paseo.fyi
SITE_dev-test      := testnet.li

# Only polkadot is prod. The rest share the staging box.
REMOTE_FOR_polkadot      := $(REMOTE_PRD)
REMOTE_FOR_paseo         := $(REMOTE_STG)
REMOTE_FOR_dev-paseo     := $(REMOTE_STG)
REMOTE_FOR_fyi-paseo     := $(REMOTE_STG)
REMOTE_FOR_dev-test      := $(REMOTE_STG)

DEPLOY_PATH_polkadot      := /var/www/dotli
DEPLOY_PATH_paseo         := /var/www/paseoli
DEPLOY_PATH_dev-paseo     := /var/www/paseolidev
DEPLOY_PATH_fyi-paseo     := /var/www/paseofyi
DEPLOY_PATH_dev-test      := /var/www/testnetli

# One cert per env at /etc/letsencrypt/live/<base>/, matching the ssl_certificate paths. *.<base> covers host.<base>.
CERT_DOMAINS_polkadot     := dot.li *.dot.li *.app.dot.li
CERT_DOMAINS_paseo        := paseo.li *.paseo.li *.app.paseo.li
CERT_DOMAINS_dev-paseo    := paseoli.dev *.paseoli.dev *.app.paseoli.dev
CERT_DOMAINS_fyi-paseo  := paseo.fyi *.paseo.fyi *.app.paseo.fyi
CERT_DOMAINS_dev-test     := testnet.li *.testnet.li *.app.testnet.li

VALID_ENVS := polkadot paseo dev-paseo fyi-paseo dev-test

RATE_LIMITED_ENVS := paseo dev-test

# Cut from SENTRY_DSN, shaped https://<key>@<ingest-host>/<project-id>.
SENTRY_DSN ?=
_sentry_hostpath := $(lastword $(subst @, ,$(SENTRY_DSN)))
SENTRY_INGEST    := $(firstword $(subst /, ,$(_sentry_hostpath)))
SENTRY_PROJECT   := $(lastword  $(subst /, ,$(_sentry_hostpath)))

ENV ?= paseo

# Checked out as truapi/hosts/dotli, local builds use the checked-out TrUAPI packages.
TRUAPI_REPO ?= $(abspath ../..)
TRUAPI_LOCAL_PACKAGE := $(TRUAPI_REPO)/js/packages/truapi/package.json
TRUAPI_HOST_LOCAL_PACKAGE := $(TRUAPI_REPO)/js/packages/truapi-host/package.json

# The brotli module is split across two packages on noble, both auto-loaded. curl and ca-certificates back certbot.
APT_PACKAGES := nginx libnginx-mod-http-brotli-filter libnginx-mod-http-brotli-static certbot python3-certbot-dns-cloudflare rsync ufw curl ca-certificates

.PHONY: build link-truapi-local provision provision-prereqs provision-firewall provision-cloudflare-creds provision-cert provision-renewal deploy ci-deploy deploy-nginx render-nginx _require-env _require-env-name

build: link-truapi-local
	npm run build

link-truapi-local:
	@if [ -f "$(TRUAPI_LOCAL_PACKAGE)" ] && [ -f "$(TRUAPI_HOST_LOCAL_PACKAGE)" ]; then \
		TRUAPI_REPO="$(TRUAPI_REPO)" npm run link:truapi; \
	else \
		echo "No local TrUAPI checkout found at $(TRUAPI_REPO); using package manager dependencies."; \
	fi

# Idempotent fresh-server provisioning:
#   make provision ENV=<env> ADMIN_EMAIL=<email> CLOUDFLARE_API_TOKEN=<token> [REMOTE=ubuntu@1.2.3.4]
# The Cloudflare token needs DNS edit permission on the zone.
provision: provision-prereqs provision-firewall provision-cloudflare-creds provision-cert provision-renewal deploy deploy-nginx
	@echo
	@echo "Provisioning complete for ENV=$(ENV)."

provision-prereqs: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'set -euo pipefail; \
		sudo DEBIAN_FRONTEND=noninteractive apt-get update -y; \
		sudo DEBIAN_FRONTEND=noninteractive apt-get install -y $(APT_PACKAGES); \
		sudo rm -f /etc/nginx/sites-enabled/default'

# OpenSSH first, so enabling ufw never locks us out.
provision-firewall: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'sudo ufw allow OpenSSH && sudo ufw allow "Nginx Full" && sudo ufw --force enable'

# The token is piped over SSH and never written locally.
provision-cloudflare-creds: _require-env
	@test -n "$(CLOUDFLARE_API_TOKEN)" || (echo "CLOUDFLARE_API_TOKEN not set"; exit 1)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	@printf 'dns_cloudflare_api_token = %s\n' '$(CLOUDFLARE_API_TOKEN)' | ssh $(REMOTE_TARGET) 'sudo install -d -m 0700 /etc/letsencrypt && sudo tee /etc/letsencrypt/cloudflare.ini > /dev/null && sudo chmod 600 /etc/letsencrypt/cloudflare.ini && sudo chown root:root /etc/letsencrypt/cloudflare.ini'

# --keep-until-expiring and --expand make re-runs safe. --cert-name pins live/<name>/ to the ssl_certificate paths.
provision-cert: _require-env
	@test -n "$(ADMIN_EMAIL)" || (echo "ADMIN_EMAIL not set"; exit 1)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval CERT_FLAGS := $(foreach d,$(CERT_DOMAINS_$(ENV)), -d '$(d)'))
	ssh $(REMOTE_TARGET) "sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini --dns-cloudflare-propagation-seconds 30 --non-interactive --agree-tos -m '$(ADMIN_EMAIL)' --keep-until-expiring --expand --cert-name $(SITE_$(ENV)) $(CERT_FLAGS)"

provision-renewal: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'sudo systemctl enable --now certbot.timer'

# Builds locally, then rsyncs only the dist directories.
deploy: _require-env build
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval REMOTE_PATH   := $(DEPLOY_PATH_$(ENV)))
	ssh $(REMOTE_TARGET) 'sudo install -d -m 0755 -o $$(whoami) -g $$(id -gn) $(REMOTE_PATH) $(REMOTE_PATH)/host $(REMOTE_PATH)/app $(REMOTE_PATH)/protocol'
	$(call _rsync_dist,$(REMOTE_TARGET),$(REMOTE_PATH))

# A literal "#" goes through _hash because make >= 4.3 keeps the backslash of a "\#" inside a function call.
_hash := \#
# Each site gets its own snippets directory, so a deploy for one env never changes the snippets of its neighbours.
_nginx_snippets = /etc/nginx/snippets/$(SITE_$(ENV))
# Renders the file $(1) for ENV. Snippets go through it too, since they include each other by ${SNIPPETS}.
_nginx_render = DOMAIN='$(SITE_$(ENV))' WEBROOT='$(DEPLOY_PATH_$(ENV))' SNIPPETS='$(_nginx_snippets)' \
	ZONE='rl_$(subst .,_,$(SITE_$(ENV)))' \
	RL='$(if $(filter $(ENV),$(RATE_LIMITED_ENVS)),,$(_hash))' \
	SENTRY='$(if $(SENTRY_DSN),,$(_hash))' \
	SENTRY_INGEST='$(SENTRY_INGEST)' SENTRY_PROJECT='$(SENTRY_PROJECT)' \
	envsubst '$$DOMAIN $$WEBROOT $$SNIPPETS $$ZONE $$RL $$SENTRY $$SENTRY_INGEST $$SENTRY_PROJECT' < $(1)

# Warns on stderr, since render-nginx pipes stdout. Envs without Sentry are legitimate, a silently dead tunnel is not.
_sentry_warn = @test -n "$(SENTRY_DSN)" || \
	echo "WARNING: SENTRY_DSN not set — rendering with the Sentry tunnel (/t) disabled." >&2

# Prints the rendered nginx config for ENV, with no remote changes.
render-nginx: _require-env-name
	@command -v envsubst >/dev/null || { echo "render-nginx needs 'envsubst' (gettext). Install: brew install gettext / apt-get install gettext-base"; exit 1; }
	$(_sentry_warn)
	@$(call _nginx_render,nginx/nginx.conf.template)

deploy-nginx: _require-env
	@command -v envsubst >/dev/null || { echo "deploy-nginx needs 'envsubst' (gettext). Install: brew install gettext / apt-get install gettext-base"; exit 1; }
	$(_sentry_warn)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval SITE := $(SITE_$(ENV)))
	$(call _nginx_render,nginx/nginx.conf.template) > /tmp/$(SITE).nginx
	rm -rf /tmp/$(SITE).snippets && mkdir /tmp/$(SITE).snippets
	for f in nginx/snippets/*.conf; do $(call _nginx_render,$$f) > /tmp/$(SITE).snippets/$${f##*/}; done
	rsync -avz --delete $(if $(SENTRY_DSN),,--exclude=dotli-sentry-tunnel.conf --delete-excluded) /tmp/$(SITE).snippets/ $(REMOTE_TARGET):/tmp/$(SITE).snippets/
	scp /tmp/$(SITE).nginx $(REMOTE_TARGET):/tmp/$(SITE).nginx
	ssh $(REMOTE_TARGET) 'sudo install -d -m 0755 $(_nginx_snippets) && sudo rsync -av --delete /tmp/$(SITE).snippets/ $(_nginx_snippets)/ && sudo cp /tmp/$(SITE).nginx /etc/nginx/sites-available/$(SITE) && sudo ln -sf /etc/nginx/sites-available/$(SITE) /etc/nginx/sites-enabled/$(SITE) && sudo nginx -t && sudo systemctl reload nginx'

define _rsync_dist
rsync -avz --delete --filter='P /assets/' apps/host/dist/     $(1):$(2)/host/
rsync -avz --delete --filter='P /assets/' apps/sandbox/dist/  $(1):$(2)/app/
rsync -avz --delete --filter='P /assets/' apps/protocol/dist/ $(1):$(2)/protocol/
endef

ci-deploy:
	@test -n "$(DEPLOY_USER)" || (echo "ci-deploy: DEPLOY_USER not set"; exit 1)
	@test -n "$(DEPLOY_HOST)" || (echo "ci-deploy: DEPLOY_HOST not set"; exit 1)
	@test -n "$(DEPLOY_PATH)" || (echo "ci-deploy: DEPLOY_PATH not set"; exit 1)
	$(call _rsync_dist,$(DEPLOY_USER)@$(DEPLOY_HOST),$(DEPLOY_PATH))
	ssh $(DEPLOY_USER)@$(DEPLOY_HOST) 'find $(DEPLOY_PATH)/*/assets/ -type f -mtime +7 -delete 2>/dev/null || true'

# No remote required, so render-nginx can use it.
_require-env-name:
	@test -n "$(ENV)" || (echo "ENV not set. Use ENV=<$(subst $() ,|,$(VALID_ENVS))>"; exit 1)
	@test -n "$(DEPLOY_PATH_$(ENV))" || (echo "Unknown ENV: $(ENV). Valid: $(VALID_ENVS)"; exit 1)

_require-env: _require-env-name
	@test -n "$(or $(REMOTE),$(REMOTE_FOR_$(ENV)))" || (echo "No deploy target for ENV=$(ENV). Set REMOTE_PRD/REMOTE_STG in deploy.env (copy deploy.env.example) or pass REMOTE=user@host."; exit 1)
