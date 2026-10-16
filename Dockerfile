# dot.li in a box: the three builds behind nginx on one port, over *.localhost. Network config is per run:
#   docker run -p 5173:5173 -e DOTLI_NETWORK='{"enabled":["previewnet"]}' dotli
#   docker run -p 5173:5173 -v ./network.json:/etc/dotli/network.json dotli
# Do not publish on port 80. `getProtocolOrigin` falls back to 5173 when the page has no port, so the protocol
# iframe would be looked for on the wrong port.

FROM node:26-slim AS build
WORKDIR /src
COPY . .
RUN npm install -g "$(node -p 'require("./package.json").packageManager')" \
 && npm ci

# Every network is compiled in and the runtime `enabled` list narrows them, so one image serves every environment.
# VITE_RUNTIME_NETWORK_CONFIG is off in hosted builds on purpose: the config repoints dotNS contracts and genesis
# hashes, a hook into the trust root for name resolution.
ENV VITE_NETWORKS=paseo-next-v2,previewnet \
    VITE_RUNTIME_NETWORK_CONFIG=true
RUN npm run build:prod

FROM nginx:alpine
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
