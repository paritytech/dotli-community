#!/bin/sh
# Generates the runtime network config, then execs the nginx image's own entrypoint.
# Config source, first match wins: mounted /etc/dotli/network.json, then $DOTLI_NETWORK, else the built-in networks.

set -eu

OUT_DIR=/etc/dotli
MOUNTED=$OUT_DIR/network.json

mkdir -p "$OUT_DIR"

# Refused here because on 80 boot would fail with nothing pointing at the cause.
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

# Malformed config must stop the container. Falling back to the built-ins would silently run against the public
# chains. The shape check also catches valid JSON of the wrong shape, such as one network's fields passed unwrapped.
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
    echo "ipfsGateways, identityBackendBaseUrl. genesis and dotns are fixed at build time." >&2
    exit 1
fi

# CSP host-sources are port-sensitive, so localhost needs the scheme and a :* wildcard. A real domain gets https,
# so the image can sit behind a TLS-terminating ingress.
DOMAIN=${DOMAIN:-localhost}
if [ "$DOMAIN" = "localhost" ]; then
    CSP="http://localhost:* http://*.localhost:*"
else
    CSP="https://$DOMAIN https://*.$DOMAIN https://*.app.$DOMAIN"
fi
export CSP DOMAIN

printf 'window.__DOTLI_NETWORK__ = %s;\n' "$CONFIG" > "$OUT_DIR/dotli-network.js"

# Lets an operator confirm an override applied without opening a browser.
echo "dotli: network config source: $SOURCE"
echo "$CONFIG" | jq -c '{enabled: (.enabled // "(built-in VITE_NETWORKS)"), networks: (.networks // {} | keys), baseDomain: (.baseDomain // "(derived from hostname)")}'
echo "dotli: serving on port ${PORT:-5173} over *.${DOMAIN}"
echo "dotli: frame-ancestors $CSP"

exec /docker-entrypoint.sh "$@"
