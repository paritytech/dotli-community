# dot.li in a box: the three builds behind nginx on one port, over *.localhost. Network config is per run:
#   docker run -p 5173:5173 -e DOTLI_NETWORK='{"enabled":["previewnet"]}' dotli
#   docker run -p 5173:5173 -v ./network.json:/etc/dotli/network.json dotli
# Do not publish on port 80. `getProtocolOrigin` falls back to 5173 when the page has no port, so the protocol
# iframe would be looked for on the wrong port.

# The manifests alone, so the install layer below is reused until a dependency changes.
FROM node:26-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS manifests
WORKDIR /src
COPY . .
RUN find . -type f ! -name package.json ! -name package-lock.json -delete \
 && find . -type d -empty -delete

FROM node:26-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS build
WORKDIR /src
COPY --from=manifests /src ./
RUN npm install -g "$(node -p 'require("./package.json").packageManager')" \
 && npm ci
COPY . .

# Every network is compiled in and the runtime `enabled` list narrows them, so one image serves every environment.
# VITE_RUNTIME_NETWORK_CONFIG is off in hosted builds on purpose: the config repoints dotNS contracts and genesis
# hashes, a hook into the trust root for name resolution.
ENV VITE_NETWORKS=paseo-next-v2,previewnet \
    VITE_RUNTIME_NETWORK_CONFIG=true
# The image has no .git to read them from, so a release passes its version and commit. A local build reports the
# package version and "dev".
ARG RELEASE_VERSION
ARG RELEASE_COMMIT
RUN if [ -n "${RELEASE_VERSION:-}" ]; then node scripts/set-version.ts "$RELEASE_VERSION"; fi \
 && if [ -n "${RELEASE_COMMIT:-}" ]; then export VITE_COMMIT_SHA="$RELEASE_COMMIT"; fi \
 && npm run build:prod

FROM nginx:alpine@sha256:72aeb3308ef6cb3118242fb16389518923916dfa206e32d1a8377acc328b9870
ENV DOMAIN=localhost WEBROOT=/srv/dotli PORT=5173

# jq: the entrypoint validates the runtime network config before nginx starts.
RUN apk add --no-cache jq

COPY --from=build /src/apps/host/dist     /srv/dotli/host
COPY --from=build /src/apps/sandbox/dist  /srv/dotli/app
COPY --from=build /src/apps/protocol/dist /srv/dotli/protocol
COPY nginx/snippets/ /etc/nginx/snippets/
COPY docker/dotli-runtime-network.conf /etc/nginx/snippets/

# Ours generates the network config, then execs the image's entrypoint, which envsubsts the templates.
COPY nginx/nginx.docker.conf.template /etc/nginx/templates/dotli.conf.template
COPY docker/entrypoint.sh /dotli-entrypoint.sh

# The stock default server would also claim a port. The official image lacks brotli_static, which would stop
# nginx from starting.
RUN rm /etc/nginx/conf.d/default.conf \
 && printf 'gzip_static on;\n' > /etc/nginx/snippets/dotli-precompressed.conf \
 && chmod +x /dotli-entrypoint.sh

EXPOSE 5173
ENTRYPOINT ["/dotli-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
