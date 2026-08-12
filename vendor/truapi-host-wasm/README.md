# Vendored TrUAPI WASM core

`web/` is the `@parity/truapi-host` 0.4.0 wasm-pack bundle rebuilt with one fix:
the Rust core validated `runtimeConfig.productId` against a hardcoded `.dot`, so
a product on a network whose dotNS TLD is `.paseo` failed to load with
`runtimeConfig.productId must be a .dot or localhost product identifier`.

- Fix: [paritytech/truapi#369](https://github.com/paritytech/truapi/pull/369).
- Built from that patch applied to truapi commit `48f8de6f`, the
  `@parity/truapi 0.7.0, @parity/truapi-host 0.4.0` release, so the JS API
  matches the version this repo pins.

It is vendored rather than pinned to a git branch because
`js/packages/truapi-host/dist/wasm/` is gitignored upstream, so a git dependency
ships no wasm and building it needs a Rust and wasm-pack toolchain in CI.

`apps/host/vite.config.ts` prefers this directory over the installed package.

## Removing this

Delete this directory and its candidate entry in `apps/host/vite.config.ts` once
`@parity/truapi-host` publishes a release carrying the fix, then bump the
dependency.
