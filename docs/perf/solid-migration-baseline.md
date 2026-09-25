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
