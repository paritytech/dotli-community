# dot.li — prebuilt bundle

A built dot.li, servable locally with no Docker and no build step. Ships the three
builds plus a small server that reproduces the production serving rules
(hostname routing, security headers, precompressed assets).

## Run it

```sh
node serve.mjs        # node >= 22
bun serve.mjs         # or bun, whichever you have
```

Then open **http://browse.localhost:5173**.

Any `*.localhost` subdomain is a `.dot` name: `browse.localhost:5173` resolves
`browse.dot`. Browsers send every `*.localhost` name to loopback, so no DNS or
hosts-file entry is needed.

## Point it at your own chain

Put JSON in `DOTLI_NETWORK`. It patches the built-in network definitions, so you
only state what differs:

```sh
DOTLI_NETWORK='{
  "enabled": ["previewnet"],
  "networks": {
    "previewnet": {
      "label": "My fork",
      "relay":    { "rpcs": ["ws://127.0.0.1:10000"] },
      "people":   { "rpcs": ["ws://127.0.0.1:10010"] },
      "assethub": { "rpcs": ["ws://127.0.0.1:10020"] },
      "bulletin": { "rpcs": ["ws://127.0.0.1:10030"],
                    "ipfsGateways": ["http://127.0.0.1:8080"] }
    }
  }
}' node serve.mjs
```

`enabled` limits which networks the Settings selector offers; the first is the
default. Overridable fields are `label`, `rpcs` and `ipfsGateways` only —
`genesis` and contract addresses are fixed at build time, because they are the
trust root for name resolution. A forked chain that preserves upstream genesis
(zombie-bite and similar) needs no more than the endpoints above.

Anything unrecognised is rejected at startup rather than ignored, so a typo fails
loudly instead of silently leaving you on the public chain.

**Overridden RPCs only apply under the Trusted Providers backend.** The light
client backends sync from chain specs and ignore `rpcs` entirely — so a container
pointed at a dead endpoint can still look healthy. Switch in Settings, or open
with `?chainBackend=rpc-gateway`.

## Options

| Variable        | Default     | Notes                                                                                                                              |
| --------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`          | `5173`      | Any port except 80 — the shell derives the protocol iframe's origin from `window.location.port`, which browsers leave empty on 80. |
| `HOST`          | `127.0.0.1` | Loopback, since the bundle is only usable over `*.localhost`. Set `0.0.0.0` only behind your own proxy.                            |
| `DIST`          | `./dist`    | Directory holding `host/`, `app/` and `protocol/`.                                                                                 |
| `DOTLI_NETWORK` | unset       | Runtime network config, as above.                                                                                                  |

## Running it on a remote machine

The bundle needs `*.localhost` — browsers resolve those to loopback and treat
them as a secure context, which service workers and SharedWorker require. So run
the server on the remote host and reach it through a tunnel:

```sh
ssh -L 5173:localhost:5173 user@host
```

Routing is decided by the `Host` header, so the tunnel is transparent. Browsing
directly to `http://host:5173` will not work.

## Docker instead

```sh
docker run -p 5173:5173 -e DOTLI_NETWORK='{…}' \
  ghcr.io/paritytech/dotli-community:VERSION
```

Same configuration, nginx instead of `serve.mjs`.
