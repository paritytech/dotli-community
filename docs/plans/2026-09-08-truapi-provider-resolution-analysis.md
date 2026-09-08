---
summary: "Measured comparison of product resolution between the PR base and the truapi-provider branch, covering cold start, refresh, multi-tab, and warm start"
read_when:
  - You are reviewing or landing PR #78 (network transport via @parity/truapi-provider)
  - You need numbers for how long resolution takes and which phase owns the time
  - You are deciding whether dotli should persist a light-client warm-start blob
  - You want to know what tabs share, and for how long
title: "truapi-provider product resolution — analysis and plan"
---

# truapi-provider product resolution — analysis and plan

## Summary

On this machine the branch resolves and renders a product in about 3.7 s cold, and the PR
base does not resolve at all: its light client cannot reach a usable relay bootnode and it
gives up after 180 s. The branch is a large functional improvement, not just a refactor.

Two gaps remain. Nothing persists light-client state across browser sessions, so a restart
pays the full ~4.5 s chain cost again, which is what justraman asked about on the PR. And
the sharing that does work only works in `smoldot-shared-worker` mode, which is not the
default: with the shared worker a second product in a second tab resolves in 0.68 s, and
without it the same navigation costs 3.87 s.

Measurements below are from a local probe (`/tmp/dotli-probe`), not the repo's perf
harness, because that harness compares a base run against a last run and the base branch
never produced a result. Sample counts are small (n = 2–3) and the network is a live
testnet, so treat the ~5–15 % differences as noise and the 5x differences as real.

## What works and what does not

Branch `tiago-truapi-provider` at 23f8c37, `@parity/truapi-provider` 0.1.1-dev-20260908.1,
network `paseo-next-v2`, product `host-playground.dot`, second product `browse.dot`.

| Scenario | Branch | PR base (6afeaaa) |
|---|---|---|
| Cold start, fresh profile | works, 3/3 | fails, 0/3 |
| Refresh (same tab, second load) | works, 3/3 | not reached |
| Second tab, same product, first tab open | works, 3/3 (+2/2 shared-worker) | not reached |
| Tab closed, then reopened | works, 3/3 | not reached |
| New browser session, same product | works, 3/3 | not reached |
| Second product, same session | works, 4/4 | not reached |
| New browser session, different product | works, 2/2 | not reached |

The base branch fails identically for every product tried. The visible failure is
"Domain can't be reached — Light client timed out", and the page error is
`ProtocolInitFailedError: Sync to Asset Hub Paseo timed out after 180s. Unable to reach
peers.` The console shows one bootnode being retried every 10 s:
`wss://n8r2.bn.turboflakes.io:30443` with `net::ERR_CONNECTION_RESET`.

The cause is the checked-in chain spec. At `6afeaaa:packages/resolver/src/chain-specs/paseo.smol.json`
the relay chain lists two bootnodes: that turboflakes WSS endpoint, and
`/ip4/139.99.130.67/tcp/30333/p2p/...`, which a browser cannot dial because it is raw TCP
with no `/ws` or `/wss` layer. So in a browser the base branch has exactly one usable relay
bootnode, and here it resets every connection. The branch's provider dialled at least four
peers for the same chain (`n8r1`, `n8v1`, `boot.interweb-it.com`, `n8r2`) plus
`webrtc-direct` addresses, and synced.

Two failures on the branch were unrelated flakes, both in the "prime" step of the
two-product scenario: 2 of 6 such loads never produced a product frame. Everything else
passed on the first attempt.

`explore.dot` is a separate, content-layer problem on both branches: the name resolves on
the branch in 4.7 s, then every bitswap peer answers `ProtocolNotAvailable` and the product
never renders. `host-playground.dot` and `browse.dot` both render, so this is that one
product's content availability, not a resolution defect.

## Measurements

Median (min–max) in ms. `resolve` is `dotli:resolve:start` → `dotli:resolve:end`;
`app frame` is navigation start → the `*.app.localhost` product frame existing.
"none" under resolve means the marks were never emitted, because the service worker served
the product without resolving anything.

| Scenario | Mode | n | ok | resolve | app frame |
|---|---|---:|---:|---:|---:|
| Cold start | direct | 3 | 3/3 | 3281 (3026–3311) | 3727 (3716–3835) |
| Cold start | shared-worker | 2 | 2/2 | 3220 (3019–3421) | 3764 (3407–4122) |
| Refresh, first load | direct | 3 | 3/3 | 2863 (2806–3439) | 3345 (3316–3936) |
| Refresh, second load | direct | 3 | 3/3 | none | 129 (126–129) |
| Two tabs, first | direct | 3 | 3/3 | 3181 (3181–3391) | 3641 (3641–3853) |
| Two tabs, second | direct | 3 | 3/3 | none | 243 (232–278) |
| Two tabs, second | shared-worker | 2 | 2/2 | none | 127 (125–129) |
| Reopen after close, first | direct | 3 | 3/3 | 3000 (2774–3108) | 3529 (3231–3558) |
| Reopen after close, second | direct | 3 | 3/3 | none | 234 (233–236) |
| New session, same product | direct | 3 | 3/3 | none | 236 (230–245) |
| Second product, same session | direct | 2 | 2/2 | 3873 (3786–3960) | 4032 (3979–4084) |
| Second product, same session | shared-worker | 2 | 2/2 | **678 (610–745)** | 842 (742–941) |
| New session, different product | shared-worker | 2 | 2/2 | **4601 (4516–4686)** | 4768 (4707–4828) |

47 samples total. Browser state per scenario: "cold", "two tabs", "refresh", "reopen" use a
fresh Playwright context per iteration (no service worker, no IndexedDB, no HTTP cache).
"New session" rows launch a persistent profile, close the browser fully, wait 2 s, and
relaunch against the same profile directory.

The PR base produced no timing rows. It was measured twice against `host-playground.dot`
after a clean rebuild, reaching `dotli:resolve:start` and never `dotli:resolve:end` before
the internal timeout. Two earlier base runs were discarded: the worktree's `dist/` still
held the previous commit's bundle, which defaulted to a network named `summit` that is not
in this deployment's list, so those runs measured the wrong build against a dead chain.

## Where the time goes

Cold start on the branch, from the provider's own wasm logging
(`sessionStorage['dotli:truapi-provider-log'] = 'info'`, wired at
`packages/resolver/src/provider.ts:46-64`):

| Phase | Typical | Evidence |
|---|---:|---|
| Provider init, wasm boot, log level set | ~220 ms | `truapi_provider::logging: log level set` |
| Relay and parachain registered | ~230 ms | `Parachain initialization complete for next-asset-hub-paseo` |
| Warp sync to a usable finalized Asset Hub state, then the storage read | ~2.8–3.1 s | gap to `dotli:resolve:end` |
| Manifest handling and product frame creation | ~300–500 ms | `dotli:resolve:end` → app frame |

So roughly 6 % of cold start is wasm startup and 80 % is the light client reaching finalized
Asset Hub state. Optimising wasm size or boot would move almost nothing; only warm start or
a shared client moves this number, which both measurements above confirm.

Once the content is cached, resolution is skipped entirely: a refresh renders in 129 ms and
never emits a resolve mark at all.

## Behaviour differences

**Warm start does not exist.** `getHandle()` builds the provider with
`new ChainProviderBuilder().build()` and never calls `setDatabase`, and nothing ever calls
`snapshot` (`packages/resolver/src/provider.ts:54-75`). The crate deliberately leaves this to
the host: `setDatabase` and `snapshot` are exposed at
`~/Projects/host-rust-core/rust/crates/truapi-provider/src/js.rs:98` and `:175`, and the
package README states that warm start is host-driven at
`js/packages/truapi-provider/README.md:49`. The PR deletes the code that used to do it,
`packages/resolver/src/smoldot-db.ts` (316 lines) and its 222-line test.

The measurement matches the code. After a full browser restart on the same profile, a
product whose content is already cached renders in 236 ms, but that is the service worker,
not the chain. Load a *different* product in that restarted session and resolution costs
4601 ms, which is no better than a cold start. Only one `dotli` IndexedDB database exists in
every run; no chain-database blob is stored.

**Tabs share, but only in shared-worker mode, which is not the default.**
`defaultBackend()` returns `"smoldot-direct"` (`packages/config/src/mode.ts:145-147`), so a
fresh install gives every tab its own light client. All unforced runs reported
`mode=direct`. Forcing `dotli:chain-backend = smoldot-shared-worker`
(`packages/config/src/mode.ts:33`) makes the SharedWorker own one client for every tab
(`apps/protocol/src/protocol-shared-worker.ts:4-10`), and the difference is large: a second
product in a second tab costs 678 ms shared versus 3873 ms direct. That state lives only as
long as one tab stays open.

The fast second tab in the *same* product scenario (127–243 ms) is the content cache, not
chain sharing. It is equally fast in direct mode, where nothing is shared.

**The crate's catalog moved twice in the version window.** Between the PR's pin
(0.1.1-dev-20260814.0) and the one measured here (0.1.1-dev-20260908.1), eight crate commits
landed, two of which rewrote the bundled network catalog: `de19f3c5` (#460, 2026-08-25,
"refresh bundled chain specs") and `594c6d9d` (#579, 2026-09-02, "follow previewnet and
paseo-next-v2 through their wipes"). Both touch `rust/crates/truapi-provider/networks/*.json`
and `src/networks.rs`, including `paseo.json` and the paseo-next-v2 chains used in every
measurement here. The npm dev versions are date-stamped auto-publishes, and the published
list (…20260825.0, …20260902.0) lines up with those two dates.

That is the practical difference between this repo's deleted chain specs and the crate: spec
freshness is now someone else's release, picked up by a version bump rather than by a
`scripts/update-chain-specs.sh` run in this repo.

**Chain specs.** The base branch resolves chains from specs checked into
`packages/resolver/src/chain-specs/`, which the PR deletes; the branch resolves them from the
crate's bundled catalog by genesis hash (`packages/resolver/src/provider.ts:89-96`,
gated by `getActiveSupportedGenesisHashes()`). That swap is what fixed the bootnode problem,
and it also means bootnode freshness now moves out of this repo and into the crate.

**Perf harness gap.** `apps/host/tests/performance/cold-start.spec.ts:86-95` still measures
`dotli:smoldot:init:*`, `:relay:*`, `:parachain:*`, `:sync:*` and `:sw:*`. Neither branch
emits any of those marks, so five of the harness's phase rows are dead on both sides. Only
`dotli:main:*`, `dotli:sw:*`, `dotli:resolve:*` and the app-side `dotli:app:*` /
`dotli:fetch:*` marks carry data.

## Risks and unknowns

- **The base-branch failure may be partly environmental.** One turboflakes endpoint resetting
  connections is a property of this network path, not of the code. What is not
  environmental is that the spec offers no browser-dialable alternative. Cheapest check: add
  one working `wss` bootnode to `paseo.smol.json` on a scratch branch off 6afeaaa and retry.
  Until then, "base is broken" holds for this machine and is not proven for CI.
- **Small n.** 2–3 iterations per cell, live testnet, one machine. The 5x gaps are far
  outside the observed spread; anything under about 15 % should not be read as a difference.
- **Flakiness is real but uncharacterised.** 2 of 7 "prime" loads produced no product frame.
  I did not determine whether that is peer selection, bitswap, or the harness.
- **Shared-worker mode was forced via localStorage**, not chosen through the UI. It behaved
  correctly, but this was not an end-user path.
- **The measured pin is newer than the PR's pin.** These runs used
  0.1.1-dev-20260908.1, bumped during this session. The PR on GitHub still pins
  0.1.1-dev-20260814.0, so CI is testing an older catalog than the numbers above.
- **`explore.dot` content is unavailable** and I did not find out why. It is out of the
  resolver's scope but it does block that product entirely.

## Phased plan

### Phase 1 — answer the review and stop measuring blind

Goal: the PR carries an accurate account of what it changes, and the perf harness stops
reporting empty phases.

1. Reply to justraman: no persistence today, cross-session cost measured at 4601 ms, the
   crate exposes `snapshot`/`setDatabase` but persists nothing itself.
2. Delete or re-point the five dead `dotli:smoldot:*` phase pairs in
   `apps/host/tests/performance/cold-start.spec.ts`.
3. Update `docs/smoldot.md`, which still describes `packages/resolver/src/smoldot.ts` as the
   source of both clients. That file no longer exists on this branch.

Exit criteria: PR question answered; `bun run --cwd apps/host test:perf` prints no phase
whose value is always zero; `docs/smoldot.md` names `provider.ts`.

### Phase 2 — restore warm start

Goal: a returning visitor does not pay a full warp sync for a product they have not cached.

The deleted implementation is a usable blueprint, and most of it carries over unchanged
because the crate's `snapshot()` asks the same `chainHead_unstable_finalizedDatabase` RPC
that `tapChain` used to issue by hand. What it did, at `6afeaaa`:

| Concern | Base branch behaviour |
|---|---|
| Store | IndexedDB `dotli-smoldot-db`, object store `chain-db`, version 1 (`smoldot-db.ts:14-16`) |
| Key | `` `${getNetwork()}:${chainName}` ``, e.g. `paseo-next-v2:asset-hub` (`smoldot.ts:163`) |
| Chains persisted | relay, bulletin, people, asset-hub, custom-relay (`smoldot.ts:330,367,433,457,488`) |
| Save trigger | 30 s after the chain is added, then every 60 s (`smoldot.ts:209-216`) |
| Size limits | discard or skip below 100 KB, cap 8 MB (`smoldot-db.ts:17-20`) |
| Load | at `addChain` time, passed as `databaseContent` (`smoldot.ts:326-334`) |

1. Add a persistence module in `packages/resolver` that stores one blob per genesis hash in
   IndexedDB, reusing the table above. Key by genesis hash rather than chain nickname, since
   that is what the provider's API takes. Keep the 100 KB floor: it exists because a
   truncated blob makes smoldot hang rather than fall back, and keep the 8 MB cap, which
   matches the crate's own `SNAPSHOT_MAX_BYTES`.
2. In `provider.ts`, call `setDatabase` for each stored blob before `build()`, and schedule
   `snapshot` on the same 30 s / 60 s cadence. The crate's `snapshot()` opens its own
   connection and times out after 60 s if the chain has not finalized, so it needs no
   readiness signal from us, but it does need the same in-flight guard the old code had.
3. Re-run the "new session, different product" scenario.

Exit criteria: that scenario's resolve median drops below 1.5 s, from 4601 ms, with the
blob visible in IndexedDB after the first session.

### Phase 3 — revisit the default backend

Goal: decide with data whether `smoldot-direct` should stay the default.

1. Reproduce the direct-versus-shared second-product gap with n ≥ 10.
2. Measure memory and CPU for both, since a shared client serving many tabs is the reason
   direct mode exists.
3. Either change `defaultBackend()` or write down why direct wins despite costing 3.2 s
   extra per new product.

Exit criteria: a decision recorded in `docs/`, with the numbers behind it.

## Checklist

- [ ] Reply to the persistence question on PR #78 — GitHub — done when the comment states the measured 4601 ms cross-session cost and names `snapshot`/`setDatabase`.
- [ ] Land the version bump on the PR — `packages/resolver/package.json:33` — done when the pin reads 0.1.1-dev-20260908.1 so CI tests the catalog these numbers came from.
- [ ] Remove dead smoldot phase pairs — `apps/host/tests/performance/cold-start.spec.ts` — done when every printed phase has non-zero values on the branch.
- [ ] Refresh the smoldot doc — `docs/smoldot.md` — done when it describes `packages/resolver/src/provider.ts` and the crate catalog instead of the deleted files.
- [ ] Confirm the base-branch bootnode diagnosis — scratch branch off 6afeaaa — done when a spec with one added `wss` bootnode either resolves or still fails, and the result is recorded here.
- [ ] Add the chain-database store — new file in `packages/resolver/src` — done when a blob for the Asset Hub genesis survives a browser restart.
- [ ] Wire load and save into the provider — `packages/resolver/src/provider.ts` — done when `setDatabase` is called before `build()` and `snapshot` after finalization.
- [ ] Re-measure warm start — `/tmp/dotli-probe/scenarios.ts` session2b — done when the resolve median is under 1.5 s across a restart.
- [ ] Characterise the 2-in-7 prime flake — done when the failure is attributed to peer selection, bitswap, or the harness.
- [ ] Decide the default backend — `packages/config/src/mode.ts:145` — done when the choice and its numbers are written down.
