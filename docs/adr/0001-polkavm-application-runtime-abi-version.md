# ADR 0001: PolkaVM application runtime ABI stays at version 1

- Status: accepted
- Date: 2026-09-07
- Applies to: `packages/resolver`, `apps/sandbox`

## Context

An App v2 manifest declares two independent version numbers:

```json
{
  "$v": 2,
  "runtime": { "kind": "polkavm", "abiVersion": 1 }
}
```

`$v` versions the manifest document. `runtime.abiVersion` selects the guest
boundary: the imports, records, and memory rules a PolkaVM application is
compiled against. They move independently, and conflating them has now caused
two production incidents on `westendli.dev`.

Two numbering claims were in circulation:

- **ABI 1.** The only application contract the runtime repository publishes is
  [`docs/runtime/polkavm-app-abi-v1.md`](https://github.com/paritytech/polkavm-host-runtime/blob/main/docs/runtime/polkavm-app-abi-v1.md),
  whose own example manifest declares `"abiVersion": 1`. `polkavm-app-kit`
  enforces 1 in `scripts/prepare-app.mjs` and asserts it in
  `tests/manifest-v2.test.mjs`, so every App the kit has ever packaged declares
  1.
- **ABI 2.** The `@useragent-kit/polkavm-runtime` distribution records
  `abi.runtime: 2` in its `SOURCE.json`, and the unmerged runtime PR
  "rename runtime surfaces to PolkaVM" proposes versioning a future breaking
  contract as App ABI v2.

A Host that requires 2 refuses every App the kit publishes; a Host that
requires 1 refuses the products that were republished to match the strict-2
Host. The gate was flipped in both directions three times in one day, and each
flip stranded whichever half of the fleet was not republished alongside it.

## Decision

**The PolkaVM application runtime ABI is version 1. Hosts accept
`runtime.abiVersion === 1` and nothing else.**

ABI 1 was never publicly released, so there is no compatibility pressure to
retire it: a breaking change is spent inside v1 rather than burning a version
number nobody has shipped against.

`abi.runtime` in a runtime distribution's `SOURCE.json` is packaging metadata
for that distribution. It is not the guest contract and MUST NOT be read as the
value an App manifest declares.

The vendored browser runtime therefore tracks
`paritytech/polkavm-host-runtime` directly — the repository whose ABI v1
contract this Host implements — through the `@parity/pvm-browser-runtime`
release tarball recorded in `scripts/polkavm-runtime.lock.json`. Repinning to a
redistribution that declares `abi.runtime: 2` reintroduces exactly the
ambiguity this ADR settles, and drops whatever upstream has merged since that
redistribution was cut.

## Consequences

- `packages/resolver/src/manifest-types.ts` types `runtime.abiVersion` as `1`
  and rejects anything else; `apps/sandbox/src/polkavm-runtime.ts` enforces the
  same value when it loads an App v2 manifest. The capability ABIs
  (`graphics`, `deviceInput`, `audio`) stay at 1 and are unaffected; the
  host-interface (computer) contract still forbids `runtime.abiVersion`
  entirely, because its interface ids carry the version.
- `apps/host/tests/smoke/polkavm-products.spec.ts` asserts the published
  products declare runtime ABI 1, so a regression fails the post-deploy smoke
  instead of the next person's phone.
- Moving to ABI 2 requires, in this order: a published v2 contract document
  upstream, a Host that accepts both during the transition, every product
  republished, and this ADR superseded. Flipping the Host gate alone is not a
  migration — it is an outage.

## References

- `packages/resolver/tests/manifest-types.test.ts` — "accepts only the published
  PolkaVM runtime ABI"
- Reverted twice as `bd767c5` and `f24d3dc`; restored as `1f69811` and this
  change.
