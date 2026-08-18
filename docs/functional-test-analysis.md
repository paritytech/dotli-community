# Functional test analysis

Status as of 2026-08-17. Investigation covered CI history, the test suite itself,
the on-chain state of `host-playground.paseo`, and a local reproduction.

## Summary

The Functional job is green on `main` today (`f75874f6`). It was red for exactly
five consecutive runs between 2026-08-04 and 2026-08-14, and the failure was
stable rather than flaky: the same 15 specs, the same error text, and the same
run duration every time.

No defect in this repository caused it. The shell could not resolve
`host-playground.paseo` because the name had no usable contenthash for the
network the shell was reading. Two separate problems produced that, one after
the other, which is why the suite stayed red across a config fix that looked
like it should have helped.

The job is green now, but the underlying fragility is untouched. A suite that
depends on live cross-repo deployment state will go red again, and when it does
it will produce an error string and nothing else to debug with.

## How the gate works

The `functional` job in `.github/workflows/test.yml` runs three spec files and
discards Playwright's exit code with `|| true`. Only a `jq` threshold decides
the outcome.

| Spec                 | Tests | Nature            | Threshold          |
| -------------------- | ----- | ----------------- | ------------------ |
| `loading.spec.ts`    | 16    | Hermetic          | 0 failures allowed |
| `resolution.spec.ts` | 3     | Network dependent | 2 failures allowed |
| `navigation.spec.ts` | 12    | Network dependent | none               |

Two consequences follow, and both showed up in this incident.

`resolution.spec.ts` has three tests and tolerates two failures, so the job only
turns red when all three chain backends fail at once. Anything less is invisible.

`navigation.spec.ts` has no threshold at all. All 12 of its tests can fail
without affecting the job's outcome. In every red run they did.

## Timeline

dot.li Functional runs on `main`, alongside `paritytech/host-playground` deploy
runs.

| When (UTC)       | Event                                                          |
| ---------------- | -------------------------------------------------------------- |
| 2026-08-04 13:18 | Functional green at `92f55bcf`, 31 passed                       |
| 2026-08-04 13:57 | Functional red at `584af2d1`, 16 passed and 15 failed           |
| 2026-08-06 to 10 | host-playground deploys succeed, Functional stays red           |
| 2026-08-13 11:02 | host-playground deploys begin failing, 9 consecutive failures   |
| 2026-08-13 20:56 | PR #159 lands new dotNS addresses and the `.paseo` TLD          |
| 2026-08-14 14:31 | Last failing host-playground deploy                             |
| 2026-08-14 14:39 | Functional red at `42a02ba6`, the final red run                 |
| 2026-08-14 14:44 | host-playground deploy succeeds again                           |
| 2026-08-14 15:06 | host-playground deploy succeeds, publishing the current CID     |
| 2026-08-14 15:35 | Functional green at `29ef38b6`, 31 passed                       |
| 2026-08-17 11:16 | host-playground deploys again, same name, new CID               |
| 2026-08-17 11:47 | Functional green at `f75874f6`                                  |

## Root causes

### Cause 1: cross-repo config skew, 2026-08-04 to 2026-08-13

PR #159 changed the paseo-next-v2 dotNS contracts and introduced the TLD field
in `packages/config/src/network.ts`:

```
- DOTNS_REGISTRY: "0xa1b2b939E82b2ecE55Bd8a0E283818BfC1CA6CDc"
- DOTNS_CONTENT_RESOLVER: "0x8A26480b0B5Df3d4D9b95adc24a5Ecb33A5b8F64"
+ DOTNS_REGISTRY: "0xf34054fd76BbF85f216cf9908226D5f0A72E50CA"
+ DOTNS_CONTENT_RESOLVER: "0x7F74D7CD50f5a834270E2ad395a01b01891AB37d"
+ TLD: "paseo"
```

Before that landed, the shell looked up `host-playground.dot` against the old
resolver contract. The host-playground pipeline was publishing
`host-playground.paseo` against the new one. The two repositories were reading
and writing different places, so successful deploys on 2026-08-06, 08-07 and
08-10 did nothing for the test suite. This is why the red period survived those
deploys.

The oldest two red runs confirm the name the shell was asking for, verbatim from
the logs: `This app can't be reached: Check if there is a typo in
host-playground.dot`.

### Cause 2: host-playground deploys failing, 2026-08-13 to 2026-08-14

PR #159 fixed the addresses and the TLD on 2026-08-13 20:56, but Functional
stayed red. The host-playground deploy workflow was itself failing across that
window, nine consecutive runs from 2026-08-13 11:02 to 2026-08-14 14:31, so the
name had no current contenthash under the newly configured contract.

Deploys recovered at 2026-08-14 14:44 and 15:06. The next Functional run, at
15:35, was green. That is the tightest correlation in the whole timeline and it
sits entirely outside this repository.

### What was ruled out

The commit that appears to have fixed it, `29ef38b6` "chore: refresh chain
specs", cannot be the cause. It touched only `paseo.smol.json` and
`previewnet.smol.json` by one line each, and the `rpc-gateway` backend failed
identically in the red runs. That backend never loads a chain spec or a light
client. Whatever broke was common to all three backends, which leaves only the
dotNS lookup.

Light client peering is likewise exonerated. The `rpc-gateway` failures returned
in 1.6 seconds, far too fast for a peering timeout. That is a definite negative
answer from the chain, not a stall.

Chrome Local Network Access denials appear in the logs of both red and green
runs, so they are not the discriminator either.

## Current on-chain state, verified

`host-playground.paseo` resolves correctly right now. Read directly from
`paseo-asset-hub-next-rpc.polkadot.io` against content resolver
`0x7F74D7CD50f5a834270E2ad395a01b01891AB37d`:

- `host-playground.paseo` contenthash resolves to
  `bafybeicf4gz44sofnm35p3pyo6wul35anijjx37qqi4rhumtwyt3n3l3pm`
- `app.host-playground.paseo` carries the same CID and an `executable` record
- The IPFS gateway serves the full 11 MB CAR, containing `index.html`
- The CID matches the one published by the host-playground deploy at
  2026-08-17 11:16

A local run of the full suite on `main` passes 31 of 31, with resolution
succeeding on all three backends.

## Structural weaknesses

These are the reasons this incident took so long to understand, and the reasons
it will recur.

1. **The job captures no diagnostics.** `tests/playwright.base.config.ts` sets no
   `trace`, `screenshot` or `video`, and the Functional job has no
   `upload-artifact` step. A red run leaves an error string and nothing to open.
2. **A cross-repo dependency is invisible in the failure.** The suite silently
   requires `paritytech/host-playground` to have deployed successfully to the
   matching network. Nothing in the failure output says so.
3. **`navigation.spec.ts` is ungated.** Twelve network-dependent tests can fail
   permanently without anyone noticing, because the threshold never reads them.
4. **The resolution threshold hides partial outages.** One or two backends can be
   broken indefinitely and the job stays green.
5. **The test-side network constant is unenforced.** `apps/host/tests/env.ts:21`
   documents that `NETWORK` must match the first entry of the build's
   `VITE_NETWORKS`, but nothing checks it. Reordering that variable would make
   the tests assert the wrong domain while the app is correct.
6. **`host-settings.spec.ts` is orphaned.** It sits in the Playwright `testDir`
   but is excluded by the explicit file list in CI, so roughly 20 tests never run.
7. **`reuseExistingServer: true` adopts a stale preview server.** Harmless on a
   fresh runner, a real source of false results locally.
8. **The job has no `timeout-minutes`.** Unlike `e2e-product`, which sets 35.

## Phased plan

### Phase 0: make the next failure debuggable

Nothing here changes behaviour. It is the prerequisite for everything else,
because the current job cannot tell you why it failed.

- Enable `trace: "retain-on-failure"` and `screenshot: "only-on-failure"` in
  `apps/host/tests/playwright.base.config.ts`.
- Add an `upload-artifact` step to the `functional` job, mirroring what
  `e2e-product` already does.
- Add `timeout-minutes: 20` to the `functional` job.
- On failure, print the resolved CID and the dotNS name the shell actually asked
  for, so the log distinguishes "name not found" from "content not fetchable".

### Phase 1: fail with the right diagnosis

Make an external outage announce itself instead of looking like a dot.li
regression.

- Add a preflight step to the `functional` job that reads the contenthash for
  `app.host-playground.<tld>` over plain JSON-RPC before Playwright starts.
- If the name has no contenthash, fail the job with an explicit message naming
  `paritytech/host-playground` as the upstream, not a generic test failure.
- Assert at preflight that `NETWORK` matches the first entry of `VITE_NETWORKS`,
  closing the gap at `apps/host/tests/env.ts:21`.

### Phase 2: close the gating holes

- Give `navigation.spec.ts` a threshold. It has 12 tests and currently zero
  gating.
- Reconsider the `resolution.spec.ts` tolerance of 2 of 3. Report per-backend
  results so a single persistently broken backend is visible even when the job
  is green.
- Decide whether `host-settings.spec.ts` should run in CI. Either add it to the
  file list or move it out of the Functional `testDir`.

### Phase 3: reduce the external surface

The deeper fix. Functional tests should not depend on another repository's
deployment pipeline.

- Publish a pinned fixture app to a stable name that only CI uses, deployed from
  this repo, so the suite stops tracking whatever host-playground shipped today.
- Alternatively, split the suite: keep the hermetic `loading.spec.ts` in the
  required Functional job, and move the network-dependent specs into a separate
  job that is allowed to be advisory.
- Document the cross-repo contract in `DEPLOYMENT.md`: which names the tests
  need, on which network, and who publishes them.

## Checklist

### Phase 0

- [ ] Enable Playwright `trace` on failure in `tests/playwright.base.config.ts`
- [ ] Enable Playwright `screenshot` on failure
- [ ] Add `upload-artifact` for `apps/host/tests/functional/test-results/`
- [ ] Add `timeout-minutes: 20` to the `functional` job
- [ ] Log the resolved CID and the dotNS name on resolution failure

### Phase 1

- [ ] Write the dotNS preflight probe script
- [ ] Wire the probe into the `functional` job ahead of the Playwright step
- [ ] Fail with an explicit upstream-outage message when the name is unset
- [ ] Assert `NETWORK` matches the first entry of `VITE_NETWORKS`
- [ ] Confirm the probe passes on a green run and fails on a simulated unset name

### Phase 2

- [ ] Add a failure threshold for `navigation.spec.ts`
- [ ] Emit per-backend resolution results into the job summary
- [ ] Re-evaluate the `resolution.spec.ts` tolerance of 2 of 3
- [ ] Resolve the orphaned `host-settings.spec.ts`

### Phase 3

- [ ] Choose between a CI-owned fixture app and splitting the suite
- [ ] Implement the chosen option
- [ ] Document the cross-repo test dependency in `DEPLOYMENT.md`
- [ ] Verify a full red-to-green cycle with the new arrangement

## Open question

The onset at 2026-08-04 13:57 is not fully explained. The only commit between
the last green and first red run is `584af2d1`, which has no plausible
connection to name resolution, and the host-playground deploys either side of it
succeeded. The most likely explanation is that the record under the old resolver
contract went stale or was migrated around that time, but that is inference and
not established. Phase 1's preflight probe would have answered this in one line,
which is the main argument for building it.
