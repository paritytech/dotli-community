# Solid v2 migration — size and cold-start baseline

Measured on the commit before sub-project 0 (`git rev-parse HEAD` → `4e7d53482b6acda9e2c54ca1aab803ba980bea75`).

Build command: `VITE_NETWORKS=paseo-next-v2,previewnet bun run build` (bun 1.4.2, node v26.8.1).

## Solid package versions (bump checklist)

| Package | Version |
|---|---|
| solid-js | 2.0.0-rc.9 |
| @solidjs/web | 2.0.0-rc.9 |
| @solidjs/signals | 2.0.0-rc.9 |
| @solidjs/vite-plugin | 3.0.0-next.44 |
| @solidjs/testing-library | 1.0.0-beta.3 |

On a bump: update all rows together, run `bunx solid-migration-assistant`, read the
RC changelog, re-run the measurements below.

## Before sub-project 0

### Chunk sizes (bytes)

| Chunk | Raw | Gzip |
|---|---:|---:|
| host _md.js | 6,434 | 2,902 |
| host blake2.js | 11,996 | 4,823 |
| host bridge.js | 161,565 | 45,407 |
| host browser.js | 23,475 | 8,772 |
| host chain-sync.js | 3,893 | 1,728 |
| host client.js | 12,661 | 4,680 |
| host dotli-debug-bus.js | 708 | 438 |
| host hex.js | 160 | 170 |
| host index.js | 193,581 | 62,013 |
| host manifest.js | 23,835 | 8,316 |
| host network.js | 6,003 | 2,445 |
| host panel.js | 93,299 | 28,774 |
| host proofs.js | 29,603 | 9,583 |
| host resolve.js | 161 | 164 |
| host rolldown-runtime.js | 716 | 459 |
| host rpc-resolve.js | 2,795 | 1,384 |
| host scale-ts.js | 4,931 | 2,243 |
| host spans.js | 2,530 | 1,237 |
| host src.js | 82,724 | 28,831 |
| host substrate-client.js | 5,953 | 2,562 |
| host truapi_verifiable.js | 14,623 | 3,266 |
| host twoX.js | 2,858 | 1,169 |
| host utils.js | 3,618 | 1,572 |
| host web.js | 25,371 | 7,490 |
| host worker-runtime.js | 106 | 143 |
| host worker-runtime.js | 36,640 | 10,132 |
| host ws.js | 26,771 | 9,525 |
| sandbox bitswap-bridge.js | 1,092 | 661 |
| sandbox fetch.js | 3,525 | 1,443 |
| sandbox index.js | 134,518 | 43,572 |

Two rows share the name `host worker-runtime.js`: the build emits two distinct
worker-runtime chunks (`worker-runtime-DiloRcUs.js`, 106 B, and
`worker-runtime-JSQiWauo.js`, 36,640 B) whose hashes both strip to the same
base name.

Measured with the method in `.github/workflows/bundle-size.yml` (raw byte
count and gzip -c size of every `apps/{host,sandbox}/dist/assets/*.js` file,
content hash stripped from the name).

### Cold start (`test:perf:base`, 20 runs)

| Mark pair | Median ms |
|---|---:|
| dotli:main:start → dotli:main:end | 2787 |

Full run: `PERF_RUNS=20 PERF_SAVE_BASE=1 PERF_DOMAIN_A=browse PERF_DOMAIN_B=host-playground bun run --cwd apps/host test:perf:base`,
using the Playwright `webServer` in `apps/host/tests/playwright.base.config.ts`
(auto-started preview server, chromium, headless). Cold-run p50/p95/cv for the
other harness phases, for context: End-to-end 4.39s / 5.63s / 0.15 (this is
p50/p95/cv over the full page, not the mark pair above). "Host total"
(`dotli:main:start` → `dotli:main:end`, cold) full stats: p50 2787 ms, p95 3247 ms,
p99 3292 ms, mean 2819 ms, stddev 257 ms, cv 0.09, min 2405 ms, max 3303 ms, 0
discarded outliers. Results saved by the harness to
`apps/host/tests/performance/results/base.json` (and `last.json`); Task 12
reruns `test:perf:compare` against a fresh `test:perf:base` run to diff.

## After sub-project 0

Measured on `feat/solid-v2-foundation` after Tasks 1-11 (stores, `createSyncStore`,
`mount/root.ts` + `mount/overlay-root.ts`, `SolidProbe`, producers routed
through the eight stores; none of the mount/probe files are imported by an
app entry yet). Build command and method identical to "Before sub-project 0"
above (`VITE_NETWORKS=paseo-next-v2,previewnet bun run build`; raw `wc -c`
and `gzip -c | wc -c` over every `apps/{host,sandbox}/dist/assets/*.js`, hash
stripped from the name).

### Chunk sizes (bytes)

| Chunk | Raw | Gzip | Δ gzip vs before |
|---|---:|---:|---:|
| host _md.js | 6,434 | 2,901 | -1 |
| host blake2.js | 13,490 | 5,560 | +737 |
| host bridge.js | 161,271 | 45,332 | -75 |
| host browser.js | 23,475 | 8,772 | +0 |
| host chain-sync.js | 4,355 | 1,867 | +139 |
| host client.js | 12,661 | 4,684 | +4 |
| host dist.js | 4,965 | 2,260 | +17 (renamed from `scale-ts.js`; now also bundles `@polkadot-api/json-rpc-provider`) |
| host dotli-debug-bus.js | 186 | 173 | see note¹ |
| host dotli-debug-bus.js | 629 | 399 | see note¹ |
| host hex.js | 160 | 170 | +0 |
| host html.js | 574 | 332 | new chunk, no before equivalent |
| host index.js | 128,737 | 41,035 | -20,978 (see gate note below) |
| host manifest.js | 24,228 | 8,547 | +231 |
| host network.js | 6,003 | 2,445 | +0 |
| host panel.js | 93,276 | 28,785 | +11 |
| host perf.js | 148 | 139 | new chunk, no before equivalent |
| host proofs.js | 28,069 | 8,925 | -658 |
| host resolve.js | 3,810 | 1,656 | +1,492 (`substrate-client.js` content merged in, see note²) |
| host rolldown-runtime.js | 716 | 459 | +0 |
| host rpc-resolve.js | 2,472 | 1,212 | -172 |
| host scheduled-notifications.js | 88,890 | 30,811 | new chunk, no before equivalent; statically imported and `modulepreload`ed from `index-*.js`, so it is on the eager path — see note³ for composition |
| host shared-mode.js | 103 | 131 | new chunk, no before equivalent |
| host shared-mode.js | 1,874 | 888 | new chunk, no before equivalent |
| host spans.js | 2,624 | 1,283 | +46 |
| host src.js | 82,662 | 28,784 | -47 |
| host truapi_verifiable.js | 14,623 | 3,266 | +0 |
| host twoX.js | 8,711 | 3,427 | +2,258 (`substrate-client.js` content merged in, see note²) |
| host utils.js | 3,618 | 1,572 | +0 |
| host web.js | 25,388 | 7,501 | +11 |
| host worker-runtime.js | 106 | 143 | +0 (matched by size) |
| host worker-runtime.js | 36,640 | 10,132 | +0 (matched by size) |
| host ws.js | 26,730 | 9,512 | -13 |
| sandbox bitswap-bridge.js | 1,092 | 660 | -1 |
| sandbox fetch.js | 3,525 | 1,442 | -1 |
| sandbox index.js | 158,815 | 53,034 | +9,462 (now bundles `@solidjs/signals` + `state/create-store.ts` + `state/product.ts`, reachable from `packages/ui/src/ui.ts`) |

¹ The build emits two `dotli-debug-bus` chunks after this sub-project (186 B
and 629 B gzip-173/399), where before there was one (708 B raw / 438 B gzip).
Combined after total: 815 B raw / 572 B gzip, a **+134 B gzip** increase
versus the single before chunk.

² `host substrate-client.js` (5,953 B raw / 2,562 B gzip before) has no
standalone chunk after this sub-project; rolldown merged its module into
`resolve.js`, `twoX.js`, `manifest.js`, `rpc-resolve.js`, and `src.js`
instead, per the sourcemaps. This, plus the `scale-ts.js` → `dist.js` rename,
account for the chunk-name churn above; confirmed via
`grep -l substrate-client apps/host/dist/assets/*.js.map` and the two
chunks' `sources` arrays.

³ `host scheduled-notifications-*.js` is **not** "the store chunk" — per its
sourcemap `sources` array (38 entries) it holds 5 of the 8 Solid stores
(`auth.ts`, `chat.ts`, `permissions.ts`, `product.ts`, `topbar.ts`) plus
`state/create-store.ts` and `@solidjs/signals`/`solid-js`; `theme.ts` and
`settings.ts` are bundled into `index-*.js` instead (confirmed via
`grep -o` on `index-BmjuFzMb.js.map`), and `network.ts` is not present in any
app bundle (unused in production — tree-shaken; confirmed absent from every
host and sandbox `.js.map`). The remainder of the chunk — roughly two thirds
of its bytes — is pre-existing app code that rolldown moved out of
`index-*.js` alongside the stores, not new Solid code: `@parity/truapi`
generated types/runtime, `packages/ui/src/notification.ts`,
`host-callbacks/*`, `chat/service.ts`, `packages/storage/*`,
`packages/content/src/bitswap.ts`, and `packages/ui/src/scheduled-notifications.ts`
(the chunk's name comes from this last, pre-existing file, not from any
Solid-specific feature). Approximate byte attribution: ~29%
`@solidjs/signals`, ~4% the five store modules + `create-store.ts`, ~67% the
pre-existing app code listed above.

**Gate note on `host index.js`:** matched by name alone, `index-*.js` gzip
*dropped* by 20,978 B, which trivially satisfies "Δ gzip < 3 KB". That
comparison is misleading: `index-*.js` statically imports the new
`scheduled-notifications-*.js` chunk and `index.html` `modulepreload`s it, so
both ship on the same eager path that `index.js` alone used to cover.
Combined eager cost (`index.js` + `scheduled-notifications.js`): 62,013 B
gzip before → 41,035 + 30,811 = 71,846 B gzip after, a **+9,833 B gzip**
increase. That is the number the gate is meant to catch, and it exceeds the
3 KB budget — but per note³, most of `scheduled-notifications.js` is
pre-existing app code that simply moved chunks, not new weight; the real new
eager cost this sub-project adds is **≈ +9.8 KB gzip, mostly
`@solidjs/signals`** (the store modules themselves are ~4% of the chunk,
close to negligible on their own).

**Ruling:** accepted for sub-project 0; the Solid reactive core is needed on
the eager path by sub-project 4 anyway; budget question raised with the
owner — superseded by the Solid-free stores addendum below.

### Cold start

| Mark pair | Before median ms | After median ms | Δ % |
|---|---:|---:|---:|
| dotli:main:start → dotli:main:end | 2787 | 2532 | -9.15% |

After numbers from a fresh `bun run --cwd apps/host test:perf` (10
iterations, cold phase, `apps/host/tests/performance/results/last.json`,
phase `Host total`); before numbers from the saved
`apps/host/tests/performance/results/base.json` (20 iterations, matches the
"Before sub-project 0" section above). `test:perf:compare`'s own summary
(different phase, "End-to-end", browse→browse-only) reported cold start
4.39s → 4.72s (+7.7%, Mann-Whitney z=0.37, not significant) and warm/lukewarm
starts within noise. The `Host total` mark-pair drop of 9.15% is a
*speed-up*, likely a mix of real improvement (see chunking note above — some
of the eagerly-loaded `index.js` bytes moved into
`scheduled-notifications.js`, which is also eager, so this doesn't fully
explain a speed-up) and sampling noise (10 runs after vs. 20 runs before; cv
0.10 after vs 0.09 before). Re-run with `PERF_RUNS=20` before relying on the
speed-up as a real signal — but per the umbrella spec's "no regression
beyond 5%" gate, a speed-up outside the ±5% band is not a failure.

Gates: host eager `index-*.js` Δ gzip < 3 KB → **fail** (true eager-path
delta, including `scheduled-notifications.js`, is +9,833 B gzip; the
`index-*.js` row alone reads as a pass but is not a fair comparison, see gate
note above); cold start: -9.15% (faster) → **pass** (no regression; likely
partly noise at 10 vs 20 runs — re-run with `PERF_RUNS=20` before relying on
the speed-up).

Sandbox eager `index-*.js` Δ gzip: +9,462 B (≈95% of the +10 KB
whole-migration budget; cause: `ui.ts` → `state/product` → Solid reactive
core) → over budget for sub-project 0; decision pending with the owner (same
question as the host gate) — resolved by the Solid-free stores addendum
below.

Largest single contributing chunk to the size-gate failure: `host
scheduled-notifications-*.js` (new, 88,890 B raw / 30,811 B gzip) — see
note³: only ~4% of that chunk is the store modules themselves, ~29% is
`@solidjs/signals`, and ~67% is pre-existing app code the bundler moved out
of `index-*.js`.

## After Solid-free stores (sub-project 0 addendum)

Stores no longer import Solid; components will use `useStore` (not yet
imported by app code). Measured with the same build command and method
(`VITE_NETWORKS=paseo-next-v2,previewnet bun run build`; raw `wc -c` and
`gzip -c | wc -c` over every `apps/{host,sandbox}/dist/assets/*.js`) on
`feat/solid-v2-foundation` at `df56a565` (commit "refactor(ui): make stores
Solid-free and add useStore for components").

Eager path = the entry `index-*.js` plus every chunk statically imported
by it, per the `<link rel="modulepreload">` tags in the built
`dist/index.html`. The "before migration" eager set was re-derived (not
just reused from the "Before sub-project 0" table above, which never
computed a combined eager figure for these chunks) by building `main` at
`d8f0167` fresh in a temporary git worktree
(`git worktree add <scratchpad>/wt-before d8f0167`, `bun install
--frozen-lockfile`, then the same build command), reading its
`dist/index.html` modulepreload tags, and measuring with the same `wc -c`
/ `gzip -c` method; the resulting chunk sizes matched the existing "Before
sub-project 0" table within ±2 B gzip (non-deterministic gzip framing
noise), confirming the table's rows are still valid for this comparison.
The worktree was removed afterwards (`git worktree remove`).

Host eager set:
- Before (main @ `d8f0167`, `dist/index.html` modulepreload: rolldown-runtime,
  spans, network, client, scale-ts, utils): `index.js` 62,013 + `rolldown-runtime.js`
  459 + `spans.js` 1,237 + `network.js` 2,445 + `client.js` 4,680 +
  `scale-ts.js` 2,243 + `utils.js` 1,572 = **74,649 B gzip**.
- Now (`df56a565`, `dist/index.html` modulepreload: rolldown-runtime, spans,
  network, client, dist, utils, scheduled-notifications, html, shared-mode,
  perf): `index.js` 41,025 + `rolldown-runtime.js` 459 + `spans.js` 1,283 +
  `network.js` 2,445 + `client.js` 4,684 + `dist.js` 2,260 (renamed from
  `scale-ts.js`) + `utils.js` 1,572 + `scheduled-notifications.js` 21,700 +
  `html.js` 332 + `shared-mode.js` 888 + `perf.js` 139 = **76,787 B gzip**.
  (`scheduled-notifications.js`, `html.js`, `shared-mode.js`, and `perf.js`
  are the same new/renamed chunks noted in the "After sub-project 0" section
  above — pre-existing from Tasks 1-11, not newly introduced by this
  addendum. `scheduled-notifications.js` itself dropped from 30,811 B gzip
  to 21,700 B gzip now that the stores it bundles are Solid-free — a
  **-9,111 B gzip** drop, which is the main effect of this addendum.)

Sandbox eager set:
- Before (main @ `d8f0167`, modulepreload: fetch): `index.js` 43,572 +
  `fetch.js` 1,443 = **45,015 B gzip**.
- Now (`df56a565`, modulepreload: fetch): `index.js` 43,701 + `fetch.js`
  1,443 = **45,144 B gzip**.

| Eager path | Before migration gzip | Now gzip | Δ gzip | Gate (< 3 KB) |
|---|---|---|---|---|
| host (index + static imports) | 74,649 | 76,787 | +2,138 | pass |
| sandbox (index + static imports) | 45,015 | 45,144 | +129 | pass |

Both gates pass now (host: +2,138 B < 3 KB; sandbox: +129 B < 3 KB),
reversing the two "over budget" verdicts recorded in the "After
sub-project 0" section above. The remaining host eager delta (+2,138 B) is
attributable to the pre-existing chunk churn from Tasks 1-11 (see note³
above: `html.js`, `shared-mode.js`, `perf.js` on the eager path,
`scale-ts.js` → `dist.js` rename with a merged-in dependency), not to
Solid — `@solidjs/signals` is no longer on either app's eager path.

Solid packages in app sourcemaps:

```
$ grep -l '@solidjs/signals\|@solidjs/web\|solid-js' apps/host/dist/assets/*.js.map apps/sandbox/dist/assets/*.js.map || echo "solid: absent from app bundles"
solid: absent from app bundles

$ grep -l 'use-store\|SolidProbe\|mount/root' apps/host/dist/assets/*.js.map apps/sandbox/dist/assets/*.js.map || echo "ui-only modules: absent"
apps/host/dist/assets/scheduled-notifications-DRa2aD5n.js.map
apps/sandbox/dist/assets/index-bBo73gYt.js.map
```

**Absent** (no Solid package source appears in any app sourcemap). The
second grep is a false positive, not an actual import: both matches trace
to the same JSDoc comment in `packages/ui/src/state/create-store.ts`
("Components bridge a store to a signal with `useStore` from
`components/use-store.ts`."), whose text is embedded verbatim in the maps'
`sourcesContent`. Neither map's `sources` array contains
`components/use-store.ts`, `SolidProbe`, or `mount/root` — the module
itself is not reachable from either app entry, matching Task 1's note that
`use-store.ts` is "not imported by apps." Confirmed with:

```
$ python3 -c "import json; m=json.load(open('apps/host/dist/assets/scheduled-notifications-DRa2aD5n.js.map')); print([s for s in m['sources'] if 'use-store' in s or 'SolidProbe' in s or 'mount/root' in s])"
[]
```

Future bundle checks should inspect each map's `sources` array, not the raw
map text (comments live in `sourcesContent`).

CI now measures this eager path on every PR with
`bun scripts/eager-path-size.ts <distDir>` (see `.github/workflows/bundle-size.yml`,
`host-eager-path` / `sandbox-eager-path`, warn-only budgets 90,009 B and
55,255 B gzip). The script measures gzip with the `gzip` CLI, the same method
as the tables above, so its numbers are directly comparable to them.

### Cold start

Ran `bun run --cwd apps/host test:perf && bun run --cwd apps/host
test:perf:compare` three times (10 iterations each, cold phase) against
the same `base.json` (20 iterations, pre-migration) used in the "Before
sub-project 0" section. The three runs disagreed:

| Run | Host total p50 | Δ % vs base (2787 ms) | cv | discarded | `test:perf:compare` "COLD START"/End-to-end |
|---|---:|---:|---:|---:|---|
| 1 | 3450 ms | +23.8% (slower) | 0.18 | 1 | +26.0%, Mann-Whitney z=2.78, **significant** |
| 2 | 2642 ms | -5.2% (faster) | 0.27 | 5 | +7.7%, z=0.57, not significant |
| 3 | 2417 ms | -13.3% (faster) | 0.12 | 0 | -8.7%, z=1.84, not significant |

Run 1 immediately followed the git-worktree `bun install` + production
build used to re-derive the "before" eager set above, so the machine was
under extra CPU/disk load during it; runs 2 and 3, taken back-to-back
afterwards on an otherwise idle machine, agree with each other (both
faster than base) and with the interim -9.15% result recorded in the
"After sub-project 0" section. Median of the three `Host total` p50s is
run 2's **2642 ms, Δ -5.2%** — a speed-up outside the ±5% band, which per
the umbrella spec's "no regression beyond 5%" gate is not a failure →
**pass (provisional; superseded by "Cold start A/B" below)**. Given the spread (cv
0.12-0.27 here vs 0.09 for the 20-run base,
and run 1's disagreement with runs 2-3), this is not a high-confidence
number; a dedicated `PERF_RUNS=20` run on an otherwise-idle machine would
be needed to firm it up, as the "Before sub-project 0" section already
recommends. No run showed a statistically significant regression by
Mann-Whitney on the End-to-end phase.

## Cold start A/B (20 runs each)

`main` at `d8f0167a` and `feat/solid-v2-foundation` at `41180839`,
built with the same command and measured back to back on the same idle machine
(`PERF_RUNS=20`, Playwright called directly because `test:perf` pins 10 runs).

| Build | Host total p50 | p95 | cv |
|---|---:|---:|---:|
| main | 2492 ms | 3117 ms | 0.10 |
| branch | 2530 ms | 3161 ms | 0.12 |

Δ p50: +1.5%. `compare.ts` End-to-end: z=1.00, not significant.
Gate (no regression beyond 5%): **pass**. This replaces the
provisional verdict in "After Solid-free stores" above.
