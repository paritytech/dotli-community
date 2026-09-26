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
and `gzip -c <file> | wc -c` over every `apps/{host,sandbox}/dist/assets/*.js`, hash
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
`gzip -c <file> | wc -c` over every `apps/{host,sandbox}/dist/assets/*.js`) on
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
as the tables above; its numbers match the tables exactly on macOS, and CI
(GNU gzip, and `build:prod` without `VITE_NETWORKS`) can differ slightly —
close enough for the budget check, not byte-identical.

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

## After sub-project 1 (modals and toasts)

Overlays (toasts, permission, preimage, password and confirmation dialogs) are
Solid components in a lazily loaded chunk, prefetched when the browser is idle.
Measured on `feat/solid-v2-foundation` at `e3157a8d` against the
branch before sub-project 1 (`31c67a34`), same build command, eager path via
`bun scripts/eager-path-size.ts`.

| Eager path | Before SP1 gzip | After SP1 gzip | Δ gzip | Gate (≤ +2 KB) |
|---|---:|---:|---:|---|
| host | 76,786 | 76,912 | +126 | pass |
| sandbox | 45,140 | 44,778 | -362 | pass |

Solid in startup chunks (sourcemap `sources`): none. Every startup chunk in
both apps' eager sets checked `ok []`, save one: `host
rolldown-runtime-hePW80VL.js` ships with no emitted `.js.map` (a tiny rolldown
runtime helper, present in both the before and after builds), so it was
checked with a raw-text `grep` for `solid-js`/`@solidjs` instead of its
sourcemap `sources` — also negative.

Overlays chunk: host `mount-CHtjaFkV.js` (hash from the measurement build)
55,155 B raw / 20,540 B gzip; sandbox `mount-CmyWESjc.js` (hash from the
measurement build) 53,588 B raw / 19,908 B gzip.

Cold start (20 runs each, back to back): before p50 2,666 ms, after p50
2,693 ms, Δ +1.0%; `compare.ts` End-to-end p50 3.72s → 3.76s (+1.2%),
Mann-Whitney z=0.66, not significant.
Gate (no regression beyond 5%): **pass**.

## After sub-project 2 (chat)

The chat panel's contents are Solid components in a lazily loaded chunk,
prefetched when the chat button first appears. Measured on
`feat/solid-v2-foundation` at `e125140c` against the branch before
sub-project 2 (`30d41161`), same build command, eager path via
`bun scripts/eager-path-size.ts`.

| Eager path | Before SP2 gzip | After SP2 gzip | Δ gzip | Gate |
|---|---:|---:|---:|---|
| host | 76,956 | 75,039 | -1,917 | no increase: pass |
| sandbox | 44,825 | 44,824 | -1 | unchanged: pass |

Solid in startup chunks (sourcemap `sources`): none. Every startup chunk in
both apps' eager sets checked `ok []`, save one: `host
rolldown-runtime-hePW80VL.js` ships with no emitted `.js.map` (a tiny rolldown
runtime helper, present in both the before and after builds), so it was
checked with a raw-text `grep` for `solid-js`/`@solidjs` instead of its
sourcemap `sources` — also negative.

Chat chunk (hash from the measurement build): host `mount-KOUcVPS6.js`
16,982 B raw / 6,035 B gzip.

Cold start (20 runs each, back to back): before p50 2,647 ms, after p50
2,686 ms, Δ +1.5%; `compare.ts` End-to-end p50 3.85s → 3.69s (-4.2%),
Mann-Whitney z=0.76, not significant.
Gate (no regression beyond 5%): **pass**.

## After sub-project 4a (shell prerender + hydration)

The host shell (`#topbar`, the QR pairing modal, the user popover, the mode
and permissions popovers) is prerendered at build time from a static Solid
component (`packages/ui/src/components/shell/Shell.tsx`, rendered by
`mount/prerender-plugin.ts` into `#shell` in `apps/host/index.html`) and
hydrated at boot: `apps/host/src/boot.ts` calls `hydrateShell()` before any of
`main.ts`'s other imports (including `topbar.ts`) run, so every imperative
reference into the shell is to a node Solid has already claimed. This is the
first sub-project to put Solid's runtime on the host's eager path. Functional
regression check: `apps/host/tests/functional/ui-smoke.spec.ts` gained a
JavaScript-disabled test asserting `#topbar` and `#auth-button` are attached
to the DOM (the topbar is hidden by JS on the landing page, so with JS off it
stays visible) — the whole functional suite (`bun run test:functional`, a
fresh build) passed **43 passed, 2 skipped** (42 + the new test; up from the
prior run's 42 passed, 2 skipped).

Measured on `feat/solid-v2-foundation` at `96265dfb` (Tasks 1-3 of sub-project
4a) against the commit right before sub-project 4a's Task 1
(`40fdc01d`, the spec/plan commit — code identical to the end of
sub-project 5b), built in a temporary git worktree, same build command, eager
path via `bun scripts/eager-path-size.ts`.

| Eager path | Before 4a gzip | After 4a gzip | Δ gzip | Gate |
|---|---:|---:|---:|---|
| host | 75,295 | 101,689 | +26,394 | see running total below |
| sandbox | 44,835 | 44,835 | +0 | unchanged (±50 B): pass |

Solid in startup chunks (sourcemap `sources`): **present on the host**,
confined to one new chunk, `host root-*.js` (58,778 B raw / 21,804 B gzip,
hash from the measurement build). Its `sources` array holds
`packages/ui/src/mount/root.ts` (the shared Solid hydrate/render helper
already used by the lazily-loaded overlay and chat mounts) plus
`@solidjs/signals`, `solid-js`, and `@solidjs/web` — 19 entries, no other
non-Solid source. `hydrate-shell.tsx` and `components/shell/Shell.tsx` (the
shell markup itself) are **not** in this chunk; they're inlined into
`index-*.js` instead, confirmed via `grep -l hydrate-shell
apps/host/dist/assets/*.js.map` (only `index-*.js` matches) and by reading
`root-*.js.map`'s own `sources` array directly. Every other host eager chunk
checked `ok []` via sourcemap `sources`; `host
rolldown-runtime-hePW80VL.js` ships with no emitted `.js.map` (as in prior
sections), checked with a raw-text `grep` for `solid-js`/`@solidjs` instead —
also negative. Sandbox: **absent** — both `index-*.js` and `fetch-*.js`
checked `ok []` via sourcemap `sources`.

### Running total vs the pre-migration baseline

| | Host eager gzip | Δ vs pre-migration (74,649 B) |
|---|---:|---:|
| Pre-migration (`d8f0167`) | 74,649 | — |
| After sub-project 4a (`96265dfb`) | 101,689 | **+27,040** |
| After the sub-project 4a size fix | 97,511 | **+22,862** |

> **Superseded:** the overage below was recorded at `96265dfb` and is fixed
> by the size-fix paragraph that follows it (+22,862 B, within the limit).

Amended whole-migration host limit: **+25,600 B (+25 KB) gzip** over the
pre-migration baseline. The running total after sub-project 4a is **+27,040 B,
1,440 B (≈5.6%) over that limit** — the first sub-project to land over budget
since the "Solid-free stores" addendum brought sub-project 0 back under it.
The overage traces entirely to this sub-project's own delta (+26,394 B gzip,
almost all of it the new `root-*.js` chunk's Solid runtime — see chunk note
above), on top of the +2,138 B of pre-existing chunk churn the running total
already carried in from Tasks 1-11 (unrelated to Solid, per that section's
notes). This was anticipated: sub-project 0's "Ruling" flagged that "the
Solid reactive core is needed on the eager path by sub-project 4 anyway," and
the owner amended the whole-migration limit to +25 KB specifically for this.
Flagged here for the owner's attention; sub-project 4a's task list is
recording-only and does not call for remediation (e.g. trimming
`topbar-autohide.ts`/`topbar.ts` once later sub-projects fold the shell's
imperative behavior into Solid) — that is out of scope for this task.

**Size fix (sub-project 4a, Task 5): +22,862 B, within the +25,600 B limit
(2,738 B of margin).** The shell's client module no longer carries its DOM
templates: a build-only plugin (`mount/strip-client-templates-plugin.ts`)
replaces every `template(...)` call in the client compile of
`components/shell/Shell.tsx` with `undefined` (the SSR compile that
prerenders it is untouched). Hydration claims the prerendered nodes by key and
never reads those strings; only a client render would. So a failed hydration
now restores a `cloneNode(true)` snapshot of the prerendered markup
(`data-hydrated="fallback"`, still reported to Sentry) instead of
client-rendering the shell. Both sides now render the shell inside the same
`Errored` boundary (`mount/hydration-boundary.ts`), so a key miss is caught
instead of halting Solid's reactive system for every root on the page. A
prerender whose component throws still fails the build, with the component's
own error (`mount/render-hydratable.ts`), and an error the hydrated shell
raises later is reported to Sentry (`kind: "render_error"`). The
snapshot fallback holds only while the shell is static; sub-project 4b has to
replace it before the shell gets reactive parts. Measured with the same build
command and `bun scripts/eager-path-size.ts`: host 101,689 → **97,511 B**
(−4,178 B, the `index-*.js` chunk). Sandbox eager path 44,835 B (unchanged;
its eager chunks don't include the shell or `mount/`).

### Cold start A/B (20 runs each)

`feat/solid-v2-foundation` before sub-project 4a Task 1 (`40fdc01d`) and
after Tasks 1-3 (`96265dfb`), built with the same command and measured back
to back on the same idle machine (`PERF_RUNS=20`, Playwright called directly
because `test:perf` pins 10 runs).

| Build | Host total p50 | p95 | cv | discarded |
|---|---:|---:|---:|---:|
| before | 3,456 ms | 4,977 ms | 0.20 | 1 |
| after | 3,481 ms | 4,944 ms | 0.22 | 6 |

Δ p50: **+0.7%**, well inside the ±5% gate. `compare.ts` End-to-end (context,
not gated): 4.66s → 5.12s (+9.9%), p95 6.40s → 6.73s (+5.2%), Mann-Whitney
z=1.12, not significant — the usual pattern in this doc of `Host total`
moving less than `End-to-end`, whose P2P/gateway phases are noisier and
outside the host's own boot time. The "after" run discarded more outliers
(6 of 20, vs 1 of 20 before; cv 0.22 vs 0.20) but the discard rule (>2x the
run's own best time) only trims tail noise and both runs' p50/cv stay in the
same range as prior sections, so this doesn't change the verdict.
Gate (no regression beyond 5%): **pass**.

## After sub-project 4b (lazy shell islands)

The theme toggle, the URL pill + verification shield, and the offline banner
became lazy Solid "islands": one lazily-loaded chunk
(`packages/ui/src/components/shell/islands.tsx`, loaded by
`packages/ui/src/mount/load-islands.ts`) swaps them into the still-static,
still-prerendered shell after boot, replacing the imperative versions of
those three pieces. Functional regression check: a fresh
`VITE_NETWORKS=paseo-next-v2,previewnet bun run build` followed by
`bun run test:functional` (port 5173 freed first, no stale preview server)
passed **43 passed, 2 skipped** — identical to sub-project 4a's count, and
including the theme, offline, QR and hydration tests in `ui-smoke.spec.ts`
(all six `ui-smoke.spec.ts` cases passed, among them "the theme I pick
applies at once and survives a reload," "I see an offline banner that goes
away when I'm back," "I can open the login QR modal and close it again,"
and "the prerendered shell is hydrated in place"). The name-submit test
passed on the first try (156 ms), no rerun needed.

Measured on `feat/solid-v2-foundation` at `3d37d976` against the end of
sub-project 4a (`472cb675` — spec/plan commit only, code identical to
`fe1d69d1`, confirmed via `git diff 472cb675 fe1d69d1 -- apps packages`
returning nothing), built in a temporary git worktree
(`git worktree add <scratchpad>/wt-4a-end 472cb675`, `bun install`, same
build command), eager path via `bun scripts/eager-path-size.ts`. The
worktree was removed afterwards (`git worktree remove`).

| Eager path | Before 4b gzip | After 4b gzip | Δ gzip | Gate |
|---|---:|---:|---:|---|
| host | 97,510 | 96,667 | -843 | ≤ +1,024 B (amended budget ≤ 98,536 B): pass |
| sandbox | 44,833 | 44,834 | +1 | unchanged (±50 B): pass |

(The 4a-end worktree re-measured at 97,510 B gzip, 2 B under the 97,512 B
figure recorded when it was first measured — the same ±2 B gzip-framing
noise already documented in the "Solid-free stores" section.)

Solid in startup chunks (sourcemap `sources`): unchanged from 4a — still
confined to `root-*.js` (`@solidjs/signals`, `solid-js`, `@solidjs/web`, and
the shared `mount/root.ts` helper). Two new chunks land on the host eager
path this sub-project: `topbar-*.js` (471 B raw / 285 B gzip, sourcemap
`sources`: `state/topbar.ts` only) and `verification-shield-*.js` (1,107 B
raw / 590 B gzip, `sources`: `state/theme.ts`, `theme-controller.ts`,
`state/url-pill.ts`, `verification-shield.ts`) — both are pre-existing
plain-JS state/logic modules that the imperative shell and the new islands
now share, not Solid code. Every other host eager chunk checked `ok []` via
sourcemap `sources` for `solid-js`/`@solidjs`; `host
rolldown-runtime-hePW80VL.js` (no emitted `.js.map`, as in prior sections)
was checked with a raw-text grep instead — also negative. These two new
chunks' combined 875 B gzip is outweighed by drops elsewhere (`index-*.js`
37,179 → 35,568 B gzip; `toasts-*.js` 1,921 → 1,797 B gzip), for a net
**-843 B** on the host eager path — this sub-project made the eager path
smaller, not larger. Sandbox: **absent**, and no islands chunk — the shell
islands are host-only, so sandbox's two eager chunks are byte-for-byte the
same modules as 4a (only content hashes changed).

The interactive Solid island components themselves (`ThemeToggle.tsx`,
`UrlPill.tsx`, `VerificationShield.tsx`, `OfflineBanner.tsx`, `popover.ts`,
`islands.tsx`) are confined to one new chunk that is **lazy only** — absent
from `dist/index.html`'s `modulepreload` tags, not on the eager path — `host
islands-6fF34_RA.js` (hash from the measurement build): 11,823 B raw /
3,708 B gzip.

**Design change note:** the design iterated before landing on lazy islands.
An earlier version that rendered the interactive island components eagerly
(no `load-islands.ts` deferral) measured **99,189 B gzip** on the host eager
path; an interim spike measured **97,619 B gzip**. The lazy-islands design
measured above (96,667 B) beats both, and beats the sub-project 4a baseline
itself (97,510 B) — deferring the islands' own weight off the eager path
more than paid for the two small new eager chunks noted above.

### Running total vs the pre-migration baseline

| | Host eager gzip | Δ vs pre-migration (74,649 B) |
|---|---:|---:|
| Pre-migration (`d8f0167`) | 74,649 | — |
| After sub-project 4a size fix (`472cb675`, re-measured here) | 97,510 | +22,861 |
| After sub-project 4b (`3d37d976`) | 96,667 | **+22,018** |

Within the amended whole-migration host limit of +25,600 B gzip, with
3,582 B of margin — more headroom than sub-project 4a left (2,738 B),
because this sub-project's own eager-path delta was negative.

### Cold start A/B (20 runs each)

`feat/solid-v2-foundation` at the end of sub-project 4a (`472cb675`, built in
the temporary worktree above) and at HEAD after sub-project 4b (`3d37d976`),
built with the same command and measured back to back on the same idle
machine (`PERF_RUNS=20`, Playwright called directly because `test:perf` pins
10 runs).

| Build | Host total p50 | p95 | cv | discarded |
|---|---:|---:|---:|---:|
| before (4a end) | 2,639 ms | 2,905 ms | 0.07 | 0 |
| after (4b) | 2,608 ms | 3,186 ms | 0.09 | 0 |

Δ p50: **-1.2%** (faster), well inside the ±5% gate. Both runs were clean
(cv ≤ 0.09, 0 discarded outliers each), so no re-run was needed. `compare.ts`
End-to-end (context, not gated): 3.71s → 3.71s (+0.1%), Mann-Whitney z=0.30,
not significant.
Gate (no regression beyond 5%): **pass**.

## After sub-project 4c (auth, pairing, user, permissions islands)

The auth button, the QR pairing modal, the user popover and the permissions
popover became lazy Solid "islands," swapped into the still-static,
still-prerendered shell after boot by `packages/ui/src/components/shell/islands.tsx`
(loaded by `packages/ui/src/mount/load-islands.ts`, same loader as sub-project
4b's theme/URL-pill/offline-banner islands). `AuthButton.tsx`, `AuthModal.tsx`,
and `UserPopover.tsx` replace the imperative auth button, QR modal and user
popover; `PermissionsPopover.tsx` (with `PermissionRow.tsx`) replaces the
imperative permissions popover. `AuthModal.tsx` draws the QR into a `<canvas>`
via the existing `qrcode` package, still a separate lazy chunk reached by a
dynamic `import()` from inside the islands chunk (see qrcode chunk note
below). Solid-free controllers (`auth-controller.ts` and
`state/auth-modal.ts`, moved out of `topbar.ts` in this sub-project) stay on
the startup path, still eager — only the shell's rendering swaps to Solid.

Functional regression check: a fresh
`VITE_NETWORKS=paseo-next-v2,previewnet bun run build` followed by
`bun run test:functional` (port 5173 freed first, no stale preview server)
passed **43 passed, 2 skipped** — identical count to sub-projects 4a and 4b.
All eight `ui-smoke.spec.ts` cases passed (the same set as 4b; no new case
this round), including "the prerendered shell is hydrated in place and its
login button opens the QR modal" and "I can open the login QR modal and
close it again." The name-submit test passed on the first try (162 ms), no
rerun needed.

e2e selector check (e2e cannot run locally — the `truapi-host` CLI is
missing): read `apps/host/tests/e2e/{global-setup.ts,truapi.spec.ts,fixtures/paired.ts}`
against the new island components' markup.

- `#auth-button` — `AuthButton.tsx:60` (and the static placeholder,
  `Shell.tsx:67`, which the island swaps in for on mount).
- `#auth-modal-qr canvas` — `AuthModal.tsx` renders `{drawnQr().canvas}`
  inside the `#auth-modal-qr` div (`AuthModal.tsx:268-269`); the static
  placeholder is `Shell.tsx:510`.
- `#user-popover-username` — `UserPopover.tsx:81` (static placeholder
  `Shell.tsx:532`).
- `#auth-button .user-badge` — `AuthButton.tsx:78` (`.user-badge-anon`
  variant at `AuthButton.tsx:73` for the signed-out state, not selected by
  these tests).

All four selectors still match. The e2e suite's only other host-shell
selector is a generic role-based one (`getByRole("button", { name:
/^(Always allow|Allow)$/ })`) plus `.signing-modal-backdrop`, both from the
"Permission Request" grant modal added in sub-project 1 — unrelated to this
sub-project's permissions *popover* (`#permissions-popover*`, `PermissionRow.tsx`),
which no e2e test references.

Measured on `feat/solid-v2-foundation` at `61b4b16b` against the end of
sub-project 4b (`650a9df9`, "chore(ui): tidy sub-project 4b leftovers"),
built in a temporary git worktree
(`git worktree add <scratchpad>/wt-4b-end 650a9df9`, `bun install`, same
build command), eager path via `bun scripts/eager-path-size.ts`. The
worktree was removed afterwards (`git worktree remove`).

| Eager path | Before 4c gzip | After 4c gzip | Δ gzip | Gate |
|---|---:|---:|---:|---|
| host | 96,633 | 93,886 | -2,747 | ≤ 96,831 B absolute (per-commit budget): pass, 2,945 B headroom |
| sandbox | 44,831 | 44,839 | +8 | unchanged (±50 B): pass |

(The 4b-end worktree, built at `650a9df9` — one tidy-up commit after
`3d37d976`, the commit the "After sub-project 4b" section above measured —
re-measured at 96,633 B gzip host / 44,831 B gzip sandbox: 2 B over the
"about 96,631 B" figure the task brief quoted for this commit, the usual
gzip-framing noise, and close to `3d37d976`'s own 96,667 B / 44,834 B.)

Solid in startup chunks (sourcemap `sources`): unchanged from 4a/4b — still
confined to `root-*.js` (`@solidjs/signals`, `solid-js`, `@solidjs/web`, and
the shared `mount/root.ts` helper). Every other host eager chunk checked
`ok []` via sourcemap `sources` (`index`, `scheduled-notifications`,
`topbar`, `url-pill`, `toasts`, `dist`, `html`, `shared-mode`, `chat-panel`,
`network`, `client`, `scale-ts`, `scale`, `errors`, `spans`, `log`,
`create-store`, `perf`, `utils`); `host rolldown-runtime-hePW80VL.js` (no
emitted `.js.map`, as in prior sections) was checked with a raw-text grep
instead — also negative. Sandbox: **absent** — both `index-*.js` and
`fetch-*.js` checked `ok []` via sourcemap `sources`.

**Lazy islands chunk** (host-only, absent from `dist/index.html`'s
`modulepreload` tags): `islands-DrHHfBc9.js` (hash from the measurement
build) 31,243 B raw / 9,302 B gzip — up from 4b's 11,823 B raw / 3,708 B
gzip, since it now also carries `AuthButton.tsx`, `AuthModal.tsx`,
`UserPopover.tsx`, `PermissionsPopover.tsx` and `PermissionRow.tsx` (the
theme/URL-pill/offline-banner islands from 4b are unchanged inside it).

**`qrcode` chunk**: still `browser-CCrYwriZ.js`, still a separate lazy
chunk (absent from the eager path), byte-for-byte **unchanged from every
prior section back to "Before sub-project 0"**: 23,475 B raw / 8,772 B
gzip, confirmed both by `wc -c`/`gzip -c` and by its sourcemap `sources`
array (27 entries, all under `node_modules/.bun/qrcode@1.5.4`, plus
`lib/browser.js` as the entry — no other module). Reached by a dynamic
`import()` from inside the islands chunk (`AuthModal.tsx`'s `toCanvas`
call), not statically bundled into it.

### Running total vs the pre-migration baseline

| | Host eager gzip | Δ vs pre-migration (74,649 B) |
|---|---:|---:|
| Pre-migration (`d8f0167`) | 74,649 | — |
| After sub-project 4b (`3d37d976`) | 96,667 | +22,018 |
| After sub-project 4b, re-measured at `650a9df9` | 96,633 | +21,984 |
| After sub-project 4c (`61b4b16b`) | 93,886 | **+19,237** |

Within the amended whole-migration host limit of +25,600 B gzip, with
6,363 B of margin — more headroom than sub-project 4b left (3,582 B),
because this sub-project's own eager-path delta was negative (deferring the
new island components off the eager path, same pattern as 4b's design
note).

### Cold start A/B (20 runs each)

`feat/solid-v2-foundation` at the end of sub-project 4b (`650a9df9`, built
in the temporary worktree above) and at HEAD after sub-project 4c
(`61b4b16b`), built with the same command and measured back to back on the
same idle machine (`PERF_RUNS=20`, Playwright called directly because
`test:perf` pins 10 runs).

| Build | Host total p50 | p95 | cv | discarded |
|---|---:|---:|---:|---:|
| before (4b end) | 2,635 ms | 3,011 ms | 0.09 | 0 |
| after (4c) | 2,700 ms | 2,998 ms | 0.07 | 0 |

Δ p50: **+2.47%**, well inside the ±5% gate. Both runs were clean (cv ≤
0.09, 0 discarded outliers each), so no re-run was needed. `compare.ts`
End-to-end (context, not gated, vs the pre-migration `base.json`): COLD
START 3.85s → 3.91s (+1.6%), Mann-Whitney z=0.96, not significant; WARM
START 1.69s → 2.05s (+21.2%, z=3.04, significant) — WARM START is not a
gated phase here (the gate is `Host total`, cold phase only, per the
umbrella spec), and this A/B's own before/after WARM p50s (not shown above)
were both taken on the same idle machine back to back, so the regression
`compare.ts` reports there is against the older pre-migration baseline, not
against 4b; LUKEWARM START 4.41s → 4.42s (+0.1%), not significant.
Gate (no regression beyond 5%): **pass**.
