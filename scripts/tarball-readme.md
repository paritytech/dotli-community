# dot.li prebuilt bundle

A built dot.li you can serve locally. No Docker, no build step. It ships the three builds plus a small server with the
production serving rules:

- hostname routing
- security headers
- precompressed assets

## Run it

```sh
node serve.mjs        # node >= 22
bun serve.mjs         # or bun, whichever you have
```

Then open **http://browse.localhost:5173**.

Any `*.localhost` subdomain is a `.dot` name: `browse.localhost:5173` resolves `browse.dot`. Browsers send every
`*.localhost` name to loopback, so you need no DNS or hosts-file entry.

## Point it at your own chain

Put JSON in `DOTLI_NETWORK`. It patches the built-in network definitions, so state only what differs:

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

- **`enabled`:** the networks the Settings selector offers. The first is the default.
- **Overridable:** only these fields:
  - `label`
  - `rpcs`
  - `ipfsGateways`
- **Fixed at build time:** `genesis` and the contract addresses. They are the trust root for name resolution. A forked
  chain that keeps the upstream genesis (zombie-bite and similar) needs only the endpoints above.
- **Strict:** anything unrecognised fails at startup. A typo cannot silently leave you on the public chain.

**Overridden RPCs apply only under the Trusted Providers backend.** The light client backends sync from chain specs and
ignore `rpcs`, so a server pointed at a dead endpoint can still look healthy. Switch in Settings, or open with
`?chainBackend=rpc-gateway`.

## Options

| Variable        | Default     | Notes                                                                                                        |
| --------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `PORT`          | `5173`      | Any port except 80. The shell derives the protocol iframe's origin from `window.location.port`, empty on 80. |
| `HOST`          | `127.0.0.1` | Loopback, since the bundle works only over `*.localhost`. Set `0.0.0.0` only behind your own proxy.          |
| `DIST`          | `./dist`    | Directory with the `host/`, `app/` and `protocol/` builds.                                                   |
| `DOTLI_NETWORK` | unset       | Runtime network config, as above.                                                                            |

## Running it on a remote machine

The bundle needs `*.localhost`. Browsers resolve it to loopback and treat it as a secure context, which service workers
and SharedWorker require. Run the server on the remote host and reach it through a tunnel:

```sh
ssh -L 5173:localhost:5173 user@host
```

- Routing follows the `Host` header, so the tunnel is transparent.
- Browsing straight to `http://host:5173` does not work.
- The protocol iframe is served under `/p/` on the bare host, `localhost:5173`. For one more release,
  `host.localhost:5173` still serves it too, for a shell cached by the previous release.

## Docker instead

Same configuration, with nginx instead of `serve.mjs`:

```sh
docker run -p 5173:5173 -e DOTLI_NETWORK='{…}' \
  ghcr.io/paritytech/dotli-community:VERSION
```
