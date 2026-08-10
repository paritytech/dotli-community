# dot.li in a box: the three builds behind nginx on one port, over *.localhost.
#
# Build once:
#   docker build -t dotli .
#
# Configure per run — no build args, no rebuild:
#   docker run -p 5173:5173 dotli
#   docker run -p 5173:5173 -e DOTLI_NETWORK='{"enabled":["previewnet"]}' dotli
#   docker run -p 5173:5173 -v ./network.json:/etc/dotli/network.json dotli
#
# Then open http://localhost:5173. See docker/entrypoint.sh for the config
# schema and RuntimeNetworkConfig in packages/config/src/network.ts for what
# each field does.
#
# Do not publish on port 80. `getProtocolOrigin` (packages/protocol/src/client.ts)
# falls back to port 5173 when window.location.port is empty, which it is on the
# default HTTP port, so the protocol iframe would be looked for on the wrong port.

FROM oven/bun:1.3.6 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile

# All built-in networks are compiled in; the runtime config's `enabled` list
# narrows the selector per container. Deliberately not a build arg — one image
# has to serve every environment, which is the whole point of this image.
#
# Debug mode is likewise not baked: it is available at runtime in any build via
# the Settings "Open in debug mode" button or ?debug=true.
#
# VITE_RUNTIME_NETWORK_CONFIG opts this build into accepting runtime config. It
# is off everywhere else on purpose: the config repoints DotNS contract addresses
# and genesis hashes, so a build that honours it hands anything running in the
# page a stable hook into the trust root for name resolution. The hosted
# deployments have no use for it and do not ship it. See
# runtime-network-config-plugin.ts and RUNTIME_CONFIG_ENABLED in network.ts —
# both halves are gated, so neither alone turns it on.
ENV VITE_NETWORKS=paseo-next-v1,paseo-next-v2,previewnet \
    VITE_RUNTIME_NETWORK_CONFIG=true
RUN bun run build:prod

FROM nginx:alpine
ENV DOMAIN=localhost WEBROOT=/srv/dotli PORT=5173

# jq: the entrypoint validates the runtime network config before nginx starts.
RUN apk add --no-cache jq

COPY --from=build /src/apps/host/dist     /srv/dotli/host
COPY --from=build /src/apps/sandbox/dist  /srv/dotli/app
COPY --from=build /src/apps/protocol/dist /srv/dotli/protocol
COPY nginx/snippets/ /etc/nginx/snippets/
COPY docker/dotli-runtime-network.conf /etc/nginx/snippets/

# The image's own entrypoint envsubsts /etc/nginx/templates/*.template into
# /etc/nginx/conf.d/ and then starts nginx; ours generates the runtime network
# config first and execs into it.
COPY nginx/nginx.docker.conf.template /etc/nginx/templates/dotli.conf.template
COPY docker/entrypoint.sh /dotli-entrypoint.sh

# The stock default server would also claim a port, and dotli-precompressed.conf
# uses brotli_static, which the official nginx image is not built with — nginx
# would refuse to start on an unknown directive. Precompressed .gz still serves.
RUN rm /etc/nginx/conf.d/default.conf \
 && printf 'gzip_static on;\n' > /etc/nginx/snippets/dotli-precompressed.conf \
 && chmod +x /dotli-entrypoint.sh

EXPOSE 5173
ENTRYPOINT ["/dotli-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
