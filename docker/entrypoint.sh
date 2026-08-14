#!/bin/sh
# Generate the runtime network config, then hand off to the nginx image's own
# entrypoint (which renders /etc/nginx/templates/*.template and starts nginx).
#
# Config source, first match wins:
#   1. /etc/dotli/network.json   — mounted file
#   2. $DOTLI_NETWORK            — inline JSON in the environment
#   3. neither                   — no overrides; built-in networks apply

set -eu

OUT_DIR=/etc/dotli
MOUNTED=$OUT_DIR/network.json

mkdir -p "$OUT_DIR"

# `getProtocolOrigin` (packages/protocol/src/client.ts) falls back to port 5173
# when window.location.port is empty, which it is on the default HTTP port. On 80
# the shell would look for the protocol iframe on the wrong port and boot would
# fail with nothing pointing at the cause, so refuse here instead.
if [ "${PORT:-5173}" = "80" ]; then
    echo "dotli: PORT=80 is not supported." >&2
    echo "The bundle derives the protocol iframe's origin from window.location.port," >&2
    echo "which browsers leave empty on port 80, so the iframe would be looked for on" >&2
    echo "port 5173 and never load. Use any other port, e.g. -p 80:5173." >&2
    exit 1
fi

if [ -f "$MOUNTED" ]; then
    CONFIG=$(cat "$MOUNTED")
    SOURCE="mounted $MOUNTED"
elif [ -n "${DOTLI_NETWORK:-}" ]; then
    CONFIG=$DOTLI_NETWORK
    SOURCE="\$DOTLI_NETWORK"
else
    CONFIG='{}'
    SOURCE="none (built-in networks)"
fi

# Validate before nginx starts, so a typo shows up in `docker run` output rather
# than as a blank page. Anything malformed must stop the container: silently
# falling back to the built-ins would mean running against the public chains while
# believing otherwise, which is the one outcome this mechanism exists to prevent.
#
# One expression covers every shape that is valid JSON but wrong — `null`, a bare
# string, an array, a misspelled top-level key, a stray non-object network body,
# and the common mistake of passing a single network's fields unwrapped.
SHAPE='type == "object"
  and ((keys - ["enabled", "networks", "baseDomain"]) | length == 0)
  and ((.enabled // []) | type == "array")
  and ((.networks // {}) | type == "object")
  and ((.networks // {}) | to_entries | all(.value | type == "object"))
  and ((.baseDomain // "x.y") | type == "string")'

if ! echo "$CONFIG" | jq -e "$SHAPE" >/dev/null 2>&1; then
    echo "dotli: network config from $SOURCE is not valid." >&2
    echo "Got: $(echo "$CONFIG" | head -c 200)" >&2
    echo >&2
    echo "Expected an object with only \"enabled\", \"networks\" and/or \"baseDomain\":" >&2
    echo '  {"enabled":["paseo-next-v2"],' >&2
    echo '   "networks":{"paseo-next-v2":{"assethub":{"rpcs":["ws://host.docker.internal:9944"]}}}}' >&2
    echo >&2
    echo "See docs/docker.md. Overridable fields are endpoints only: label, rpcs," >&2
    echo "ipfsGateways. genesis and dotns are fixed at build time." >&2
    exit 1
fi

# frame-ancestors for the iframeable origins. Localhost serves plain HTTP on a
# non-default port, and CSP host-sources are port-sensitive, so it needs the
# scheme and a :* wildcard. A real domain gets the https triple instead, which is
# what lets this image sit behind an ingress terminating TLS.
DOMAIN=${DOMAIN:-localhost}
if [ "$DOMAIN" = "localhost" ]; then
    CSP="http://localhost:* http://*.localhost:*"
else
    CSP="https://$DOMAIN https://*.$DOMAIN https://*.app.$DOMAIN"
fi
export CSP DOMAIN

printf 'window.__DOTLI_NETWORK__ = %s;\n' "$CONFIG" > "$OUT_DIR/dotli-network.js"

# Echo the effective config. This is how an operator answers "did my override
# actually apply?" without opening a browser.
echo "dotli: network config source: $SOURCE"
echo "$CONFIG" | jq -c '{enabled: (.enabled // "(built-in VITE_NETWORKS)"), networks: (.networks // {} | keys), baseDomain: (.baseDomain // "(derived from hostname)")}'
echo "dotli: serving on port ${PORT:-5173} over *.${DOMAIN}"
echo "dotli: frame-ancestors $CSP"

exec /docker-entrypoint.sh "$@"
