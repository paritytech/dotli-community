# Solid v2 SP0 — review fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the owner's answers to the SP0 open questions (recorded in `SOLID_MIGRATION_QUESTIONS.md`, "Your answers") so `feat/solid-v2-foundation` is ready to go up as one PR.

**Architecture:** Six small, independent changes on the existing branch: two code cleanups, a CI eager-path size check, a Playwright UI smoke spec that automates most of the manual checklist, a spec note for SP4, and a 20-run cold-start A/B that replaces the provisional result. No store or component behavior changes.

**Tech Stack:** Bun 1.3.13, TypeScript 6 strict, Vitest 5 (packages), Playwright (host functional suite), GitHub Actions (bash), `node:zlib`.

**Spec:** `docs/superpowers/specs/2026-09-25-solid-v2-sp0-foundation-design.md` (parent: `docs/superpowers/specs/2026-09-25-solid-v2-ui-migration-design.md`). Decisions: `SOLID_MIGRATION_QUESTIONS.md` → "Your answers (2026-09-25 review)".

## Global Constraints

- Work on branch `feat/solid-v2-foundation`. Never push, open a PR or merge; the owner does that after review (Q1: one PR with specs, plans and code).
- Every window event keeps its exact name and detail shape; `dotli:permission-changed` shapes stay as they are (Q5: unified in SP4, not here).
- `ERRORS` string values in `packages/ui/src/errors.ts` must not change (pinned external contract).
- Size budgets (umbrella spec, whole migration, gzip, eager path = entry module + every `<link rel="modulepreload">` chunk in `dist/index.html`): host **+15 KB** over 74,649 B → **90,009 B**; sandbox **+10 KB** over 45,015 B → **55,255 B**. CI budget overages warn; they never fail the job (same policy as the existing checks in `bundle-size.yml`).
- Cold-start gate: no regression beyond 5% on the `Host total` (`dotli:main:start` → `dotli:main:end`) median.
- New test names follow the repo's user-story style ("As a user, …") with `// Given / // When / // Then` comments where the file already uses them.
- Every commit passes `bun run typecheck`, `bun run lint`, `bun run format:check` and `bun run test`.
- Build command for measurements: `VITE_NETWORKS=paseo-next-v2,previewnet bun run build`.

## Review Focus

1. The built `index.html` changes shape (no module script, attribute order swapped, relative `./assets/` paths): the eager-size script must fail loudly or still find every chunk, never report 0 B and pass the budget. Pinned by Task 2 tests.
2. A chunk that is both the entry and modulepreloaded, or preloaded twice, must be counted once. Pinned by Task 2 tests.
3. A leftover value in the preview server's shared store (from another spec) must not hide the seeded recent pills or the toast. Pinned in Task 3 by the `shared-mode-reset` fixture plus an explicit seed.
4. Going back online must hide the offline banner again, not only show it on offline. Pinned in Task 3.
5. Choosing a theme must survive a reload (stored preference), not only flip `data-theme` in memory. Pinned in Task 3.

---

### Task 1: Code cleanups (deprecated alias strings, topbar import, setter rename)

Answers Q4 and Q12. Three commits, one review.

**Files:**
- Modify: `packages/ui/src/errors.ts:14-15`
- Modify: `packages/ui/src/topbar.ts:19` (import) and `:79`, `:1732` (setter)
- Modify: `packages/ui/src/state/topbar.ts:37`
- Modify: `packages/ui/tests/state/topbar.test.ts:8,61-67`

**Interfaces:**
- Produces: `recordChainsButtonVisible(visible: boolean): void` exported from `packages/ui/src/state/topbar.ts` (replaces `setChainsButtonVisibleState`; no event, same behavior).
- Naming ruling: Q12 proposed `setChainsButtonVisible`, but `packages/ui/src/topbar.ts:1731` already exports a DOM function with that name and imports the store setter, so the store setter is named `recordChainsButtonVisible` instead, matching `recordPermissionChange` / `recordMessage` (store writes without a DOM side effect).

- [ ] **Step 1: Deprecate the two alias error strings**

In `packages/ui/src/errors.ts`, replace the two lines

```ts
  ALIAS_PERMISSION_DENIED: "User denied alias permission",
  ALIAS_PERMISSION_DISMISSED: "User dismissed alias permission dialog",
```

with

```ts
  /**
   * @deprecated Nothing produces this since the alias permission modal was
   * removed. Kept because a product may still match on the text.
   */
  ALIAS_PERMISSION_DENIED: "User denied alias permission",
  /**
   * @deprecated Nothing produces this since the alias permission modal was
   * removed. Kept because a product may still match on the text.
   */
  ALIAS_PERMISSION_DISMISSED: "User dismissed alias permission dialog",
```

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint`
Expected: both pass (nothing references these keys, so no deprecation warnings fire).

```bash
git add packages/ui/src/errors.ts
git commit -m "docs(ui): mark alias permission error strings deprecated"
```

- [ ] **Step 2: Make the network-monitor import relative**

In `packages/ui/src/topbar.ts`, change the closing line of the import block at lines 11-19 from

```ts
} from "@dotli/ui/network-monitor";
```

to

```ts
} from "./network-monitor";
```

Leave `packages/ui/tests/*` and `apps/host/src/*` on `@dotli/ui/network-monitor` (package consumers keep the package path). Vitest resolves `vi.mock` by the resolved file, so the mock in `tests/state/network.test.ts` still applies.

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui test`
Expected: PASS, same test count as before.

```bash
git add packages/ui/src/topbar.ts
git commit -m "refactor(ui): import network-monitor relatively in topbar"
```

- [ ] **Step 3: Rename the test's call first (failing test)**

In `packages/ui/tests/state/topbar.test.ts`, change the import `setChainsButtonVisibleState,` to `recordChainsButtonVisible,` and the test body `setChainsButtonVisibleState(true);` to `recordChainsButtonVisible(true);`.

Run: `bun run --cwd packages/ui test tests/state/topbar.test.ts`
Expected: FAIL, `recordChainsButtonVisible` is not exported / not a function.

- [ ] **Step 4: Rename the setter and its caller**

In `packages/ui/src/state/topbar.ts`:

```ts
export function recordChainsButtonVisible(visible: boolean): void {
  topbar.set({ ...topbar.get(), chainsButtonVisible: visible });
}
```

In `packages/ui/src/topbar.ts`: line 79 becomes `import { recordChainsButtonVisible } from "./state/topbar";`, and inside `setChainsButtonVisible` (line 1732) `setChainsButtonVisibleState(visible);` becomes `recordChainsButtonVisible(visible);`.

Run: `git grep -n setChainsButtonVisibleState -- apps packages`
Expected: no output.

Run: `bun run --cwd packages/ui test && bun run typecheck && bun run lint`
Expected: PASS.

```bash
git add packages/ui/src/state/topbar.ts packages/ui/src/topbar.ts packages/ui/tests/state/topbar.test.ts
git commit -m "refactor(ui): rename topbar store setter to recordChainsButtonVisible"
```

---

### Task 2: Eager-path size check in CI

Answers Q6. The CI check only measures `index-*.js`, but the bundler now modulepreloads more chunks at startup, so growth there is invisible. Add a script that sums the eager path the same way `docs/perf/solid-migration-baseline.md` does, and use it in `bundle-size.yml`.

**Files:**
- Create: `scripts/eager-path-size.ts`
- Create: `scripts/eager-path-size.test.ts` (run with `bun test`; `scripts/` has no Vitest setup and CI does not run it; it guards the parser locally)
- Modify: `.github/workflows/bundle-size.yml` (budget step, PR comment, baseline JSON)
- Modify: `docs/perf/solid-migration-baseline.md` (one paragraph at the end of the "After Solid-free stores" section, before its "Cold start")

**Interfaces:**
- Produces: `eagerChunkPaths(html: string): string[]` (paths as written in the HTML, deduplicated, in document order; throws if there is no `<script type="module" src>`); `measureEagerPath(distDir: string): { files: string[]; raw: number; gz: number; br: number }`.
- CLI: `bun scripts/eager-path-size.ts <distDir>` prints one line of JSON `{"files":[...],"raw":N,"gz":N,"br":N}` and exits 1 with a message on stderr if the HTML has no module entry or a listed file is missing.

- [ ] **Step 1: Write the failing tests**

`scripts/eager-path-size.test.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "bun:test";
import { eagerChunkPaths } from "./eager-path-size";

describe("eagerChunkPaths", () => {
  it("returns the module entry and every modulepreload, in document order", () => {
    const html = `<head>
      <script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/spans-BBBBBBBB.js">
      <link rel="stylesheet" href="/assets/index-CCCCCCCC.css">
      <link rel="modulepreload" crossorigin href="/assets/client-DDDDDDDD.js">
    </head>`;
    expect(eagerChunkPaths(html)).toEqual([
      "/assets/index-AAAAAAAA.js",
      "/assets/spans-BBBBBBBB.js",
      "/assets/client-DDDDDDDD.js",
    ]);
  });

  it("accepts attributes in any order and relative paths", () => {
    const html = `<script src="./assets/index-AAAAAAAA.js" type="module"></script>
      <link href="./assets/fetch-BBBBBBBB.js" rel="modulepreload">`;
    expect(eagerChunkPaths(html)).toEqual([
      "./assets/index-AAAAAAAA.js",
      "./assets/fetch-BBBBBBBB.js",
    ]);
  });

  it("counts a chunk once when it is listed twice", () => {
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" href="/assets/index-AAAAAAAA.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">`;
    expect(eagerChunkPaths(html)).toEqual([
      "/assets/index-AAAAAAAA.js",
      "/assets/utils-BBBBBBBB.js",
    ]);
  });

  it("ignores classic scripts and non-module links", () => {
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <script src="/legacy.js"></script>
      <link rel="preload" href="/assets/font.woff2">`;
    expect(eagerChunkPaths(html)).toEqual(["/assets/index-AAAAAAAA.js"]);
  });

  it("throws when the page has no module entry, instead of reporting 0 bytes", () => {
    expect(() => eagerChunkPaths("<html><body></body></html>")).toThrow(
      /no <script type="module" src>/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test scripts/eager-path-size.test.ts`
Expected: FAIL, cannot find module `./eager-path-size`.

- [ ] **Step 3: Write the script**

`scripts/eager-path-size.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Size of what a first visit downloads before any lazy import: the module
// entry plus every chunk `dist/index.html` modulepreloads. Watching only
// `index-*.js` misses growth the bundler moves into a preloaded chunk.
//
//   bun scripts/eager-path-size.ts apps/host/dist
//   → {"files":["assets/index-….js",…],"raw":…,"gz":…,"br":…}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

const TAG = /<(script|link)\b([^>]*)>/gi;

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
  return match === null ? null : match[1];
}

export function eagerChunkPaths(html: string): string[] {
  const paths: string[] = [];
  let hasEntry = false;
  for (const [, tag, attrs] of html.matchAll(TAG)) {
    let path: string | null = null;
    if (tag.toLowerCase() === "script" && attr(attrs, "type") === "module") {
      path = attr(attrs, "src");
      hasEntry ||= path !== null;
    } else if (
      tag.toLowerCase() === "link" &&
      attr(attrs, "rel") === "modulepreload"
    ) {
      path = attr(attrs, "href");
    }
    if (path !== null && !paths.includes(path)) {
      paths.push(path);
    }
  }
  if (!hasEntry) {
    throw new Error('index.html has no <script type="module" src>');
  }
  return paths;
}

export function measureEagerPath(distDir: string): {
  files: string[];
  raw: number;
  gz: number;
  br: number;
} {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const files = eagerChunkPaths(html).map((p) => p.replace(/^\.?\//, ""));
  let raw = 0;
  let gz = 0;
  let br = 0;
  for (const file of files) {
    const bytes = readFileSync(join(distDir, file));
    raw += bytes.length;
    gz += gzipSync(bytes).length;
    br += brotliCompressSync(bytes).length;
  }
  return { files, raw, gz, br };
}

if (import.meta.main) {
  const distDir = process.argv[2];
  if (distDir === undefined) {
    console.error("usage: bun scripts/eager-path-size.ts <distDir>");
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(measureEagerPath(distDir)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test scripts/eager-path-size.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Check the script against a real build**

Run: `VITE_NETWORKS=paseo-next-v2,previewnet bun run build && bun scripts/eager-path-size.ts apps/host/dist && bun scripts/eager-path-size.ts apps/sandbox/dist`
Expected: host `files` lists the same 11 chunks as the baseline doc's "Now" host eager set (index, rolldown-runtime, spans, network, client, dist, utils, scheduled-notifications, html, shared-mode, perf) and `gz` within ±100 B of 76,787 (the doc used the `gzip` CLI, whose header differs by a few bytes per file); sandbox lists index + fetch, `gz` within ±50 B of 45,144. If the chunk list differs, stop and report — the script or the doc is wrong.

- [ ] **Step 6: Add the budget check to the workflow**

In `.github/workflows/bundle-size.yml`, inside the `Check mode-specific bundle budgets` step's `run:` block, after the `check "host-entry" …` call, append:

```bash
          # Eager path = module entry + every modulepreloaded chunk, gzip.
          # Budgets are the Solid migration's whole-migration limits
          # (docs/superpowers/specs/2026-09-25-solid-v2-ui-migration-design.md):
          # pre-migration 74,649 B + 15 KB (host), 45,015 B + 10 KB (sandbox).
          check_eager() {
            local label=$1 dist=$2 max=$3
            local json gz
            if ! json=$(bun scripts/eager-path-size.ts "$dist"); then
              echo "::warning::${label}: could not measure the eager path in ${dist}"
              echo "- \`${label}\`: could not measure the eager path in \`${dist}\`" >> /tmp/budget-warnings.md
              return
            fi
            gz=$(echo "$json" | python3 -c "import json,sys; print(json.load(sys.stdin)['gz'])")
            if (( gz > max )); then
              echo "::warning::${label} exceeded budget: ${gz} B gzip > ${max} B"
              echo "- \`${label}\` exceeded budget: **${gz} B gzip** > ${max} B" >> /tmp/budget-warnings.md
            else
              echo "${label}: ${gz} B gzip (budget ${max} B) — ok"
            fi
          }
          check_eager "host-eager-path" apps/host/dist 90009
          check_eager "sandbox-eager-path" apps/sandbox/dist 55255
```

Note the step runs after `Remove source maps`, which does not touch `.js` or `index.html`, so the measurement is valid there.

- [ ] **Step 7: Show the eager path in the PR comment and baseline**

In the `Generate baseline sizes` step, before the final `echo "" >> /tmp/bundle-baseline.json`, append two entries (keeps the existing JSON shape `{"name": {"raw","br","gz"}}`):

```bash
          for app in host sandbox; do
            json=$(bun scripts/eager-path-size.ts "apps/${app}/dist")
            printf ',\n  "%s/(eager path)": %s' "$app" \
              "$(echo "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({'raw': d['raw'], 'br': d['br'], 'gz': d['gz']}))")" \
              >> /tmp/bundle-baseline.json
          done
```

In the `Generate bundle size report` step, before the `{ echo "## Bundle Size Report"` block, compute the rows:

```bash
          eager_rows=""
          for app in host sandbox; do
            json=$(bun scripts/eager-path-size.ts "apps/${app}/dist") || continue
            read -r e_raw e_br e_gz < <(echo "$json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['raw'], d['br'], d['gz'])")
            name="${app}/(eager path)"
            e_row="| \`${name}\` | $(fmt $e_raw)$(fmt_diff $e_raw "$(baseline_val "$name" raw)") | $(fmt $e_br)$(fmt_diff $e_br "$(baseline_val "$name" br)") | $(fmt $e_gz)$(fmt_diff $e_gz "$(baseline_val "$name" gz)") |"
            eager_rows="${eager_rows}${e_row}"$'\n'
          done
```

and inside the comment block, right after the baseline-missing notice and before `# Show only chunks over 500 KB`, emit:

```bash
            if [[ -n "$eager_rows" ]]; then
              echo "**Eager path** (module entry + modulepreloaded chunks):"
              echo ""
              echo "| Path | Raw | Brotli | Gzip |"
              echo "|------|----:|-------:|-----:|"
              echo -n "$eager_rows"
              echo ""
            fi
```

The first PR after merge shows eager rows without a diff (the baseline gains the entries on the next `main` push); that is expected.

- [ ] **Step 8: Dry-run the workflow's shell locally**

Save the `Check mode-specific bundle budgets` `run:` body to `<scratchpad>/budget.sh`, replace `stat --format=%s` with `stat -f %z` (macOS), and run it from the repo root against the Step 5 build.
Expected: `host-eager-path: … B gzip (budget 90009 B) — ok` and `sandbox-eager-path: … (budget 55255 B) — ok`, no `::warning::` lines. Then temporarily change `90009` to `1000`, re-run, and confirm a `::warning::host-eager-path exceeded budget` line and a matching line in `/tmp/budget-warnings.md`. Revert the scratch copy only; do not commit it.

Run: `bunx actionlint .github/workflows/bundle-size.yml` if available (`bunx --bun actionlint` may be missing; if so, run `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/bundle-size.yml'))"` to at least check YAML).
Expected: no errors.

- [ ] **Step 9: Note it in the baseline doc**

At the end of `docs/perf/solid-migration-baseline.md`'s "After Solid-free stores" section (before its `### Cold start`), add:

```markdown
CI now measures this eager path on every PR with
`bun scripts/eager-path-size.ts <distDir>` (see `.github/workflows/bundle-size.yml`,
`host-eager-path` / `sandbox-eager-path`, warn-only budgets 90,009 B and
55,255 B gzip). The script uses Node's gzip, so its numbers can differ from the
table above by a few bytes per chunk.
```

Run: `bun run format:check && bun run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add scripts/eager-path-size.ts scripts/eager-path-size.test.ts .github/workflows/bundle-size.yml docs/perf/solid-migration-baseline.md
git commit -m "ci: check eager-path bundle size for host and sandbox"
```

---

### Task 3: Playwright UI smoke spec

Answers Q2 ("automate it too"). Covers the manual checklist items that need no chain: landing + recent pills, submitting a name, login QR modal open/close, theme choice, offline banner, a toast. Opening a `.dot` name end to end is already covered by `resolution.spec.ts`.

**Files:**
- Create: `apps/host/tests/functional/ui-smoke.spec.ts`
- Modify: `apps/host/package.json` (`test:functional` script: append `tests/functional/ui-smoke.spec.ts`)

**Interfaces:**
- Consumes: `test` from `apps/host/tests/functional/helpers/shared-mode-reset.ts` (resets the preview server's shared store before each test and disables the TrUAPI debug panel); `PORT` from `apps/host/tests/env.ts`.
- DOM contract used (current vanilla UI; SP1–SP4 must keep these ids/classes or update this spec): `#dotli-nav-form`, `#dotli-nav-input`, `#dotli-recent`, `.landing-recent-pill`, `#auth-button`, `#auth-modal-backdrop` (`.open` when shown), `#auth-modal-title`, `#auth-modal-close`, `#theme-toggle`, `#theme-popover`, `[data-theme-option="dark"]`, `html[data-theme]`, `html[data-theme-pref]`, `#offline-banner`, `.notif-card`, `.notif-title`, `.notif-card-close`.

Facts the spec relies on (verified in the source):
- Landing shows when the hostname has no label: `http://localhost:PORT/` (`parseDotLabel` in `apps/host/src/main.ts:329`). The landing hides `#topbar` but moves `#auth-button`, `#theme-toggle` and `#theme-popover` into `#landing-auth` (`packages/ui/src/ui.ts:1003-1015`).
- Recent labels on localhost come from the preview server's shared store (`/__dotli-mode/dotli_recent`, JSON array) before this origin's `localStorage` mirror (`packages/ui/src/recent-labels.ts`, `shared-mode.ts:57`).
- The offline banner is a child of `#topbar`, so it is only visible on a label page, where the topbar shows (`apps/host/src/offline.ts`).
- On desktop, with `desktop-banner-dismissed` unset, boot shows a "Get Polkadot Desktop" toast (`apps/host/src/main.ts:192-214`).
- Theme choice is stored under the topbar's `THEME_KEY` in `localStorage` (`packages/ui/src/topbar.ts:143,215`).

- [ ] **Step 1: Confirm the landing URL**

Run: `VITE_NETWORKS=paseo-next-v2,previewnet bun run build` (skip if Task 2 just built), then `bun scripts/preview-server.ts &` and `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/`; stop the server afterwards.
Expected: `200`. If not, find the hostname the preview server maps to `apps/host/dist` (`scripts/preview-server.ts:7-12`) and use a label-less form of it as `LANDING_URL` below.

- [ ] **Step 2: Write the spec**

`apps/host/tests/functional/ui-smoke.spec.ts`:

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Smoke checks for the shell UI that the Solid migration rewrites piece by
// piece. None of these wait for a chain: they stop at what the shell renders
// by itself. End-to-end resolution lives in resolution.spec.ts.

import { expect } from "@playwright/test";
import { PORT } from "../env";
import { test } from "./helpers/shared-mode-reset";

const LANDING_URL = `http://localhost:${PORT}/`;
const LABEL_URL = `http://browse.localhost:${PORT}/`;
// Same endpoint shared-mode-reset uses; 127.0.0.1 because Node on Linux does
// not resolve *.localhost.
const SHARED_STORE = `http://127.0.0.1:${PORT}/__dotli-mode/`;

test.describe("Shell UI smoke", () => {
  test("As a returning user, the landing page shows my recent sites as pills", async ({
    page,
    request,
  }) => {
    // Given
    const put = await request.put(`${SHARED_STORE}dotli_recent`, {
      data: JSON.stringify(["browse", "playground"]),
    });
    expect(put.ok()).toBe(true);

    // When
    await page.goto(LANDING_URL);

    // Then
    await expect(page.locator("#dotli-nav-form")).toBeVisible();
    const pills = page.locator("#dotli-recent .landing-recent-pill");
    await expect(pills).toHaveCount(2);
    await expect(pills.first()).toHaveAttribute("href", /browse/);
  });

  test("As a user, submitting a name on the landing page takes me to that site", async ({
    page,
  }) => {
    // Given
    await page.goto(LANDING_URL);

    // When
    await page.locator("#dotli-nav-input").fill("browse");
    await page.locator("#dotli-nav-input").press("Enter");

    // Then
    await expect(page).toHaveURL(/\/\/browse\./);
  });

  test("As a user, I can open the login QR modal and close it again", async ({
    page,
  }) => {
    // Given
    await page.goto(LANDING_URL);
    const backdrop = page.locator("#auth-modal-backdrop");

    // When
    await page.locator("#auth-button").click();

    // Then
    await expect(backdrop).toHaveClass(/\bopen\b/);
    await expect(page.locator("#auth-modal-title")).toBeVisible();

    // When
    await page.locator("#auth-modal-close").click();

    // Then
    await expect(backdrop).not.toHaveClass(/\bopen\b/);
  });

  test("As a user, the theme I pick applies at once and survives a reload", async ({
    page,
  }) => {
    // Given
    await page.goto(LANDING_URL);

    // When
    await page.locator("#theme-toggle").click();
    await expect(page.locator("#theme-popover")).toBeVisible();
    await page.locator('[data-theme-option="dark"]').click();

    // Then
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(html).toHaveAttribute("data-theme-pref", "dark");

    // When
    await page.reload();

    // Then
    await expect(html).toHaveAttribute("data-theme", "dark");
  });

  test("As a user who loses the connection, I see an offline banner that goes away when I'm back", async ({
    page,
    context,
  }) => {
    // Given
    await page.goto(LABEL_URL);
    await expect(page.locator("#topbar")).toBeVisible();
    const banner = page.locator("#offline-banner");

    // When
    await context.setOffline(true);

    // Then
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText("You are offline");

    // When
    await context.setOffline(false);

    // Then
    await expect(banner).toBeHidden();
  });

  test("As a desktop user, I see a toast I can dismiss", async ({ page }) => {
    // Given
    await page.goto(LANDING_URL);
    const card = page.locator(".notif-card", {
      has: page.locator(".notif-title", { hasText: "Get Polkadot Desktop" }),
    });

    // Then
    await expect(card).toBeVisible();

    // When
    await card.locator(".notif-card-close").click();

    // Then
    await expect(card).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("desktop-banner-dismissed"),
      ),
    ).toBe("1");
  });
});
```

- [ ] **Step 3: Run the spec**

Run: `cd apps/host && npx playwright test --config=tests/functional/playwright.config.ts tests/functional/ui-smoke.spec.ts`
Expected: 6 passed. If a test fails, read the failure against the "Facts" list above before changing the assertion. A failing assertion means either the fact is wrong (fix the spec and note why in the report) or the UI is broken (report it; do not weaken the test). Two known risks to check first: the toast may stack behind another toast (use the `has:` locator as written), and the landing may animate the auth button in (Playwright's auto-wait covers it; do not add fixed sleeps).

- [ ] **Step 4: Check the spec catches a regression**

Temporarily change `el.textContent = "You are offline";` in `apps/host/src/offline.ts` to `"Offline"`, rebuild the host (`VITE_NETWORKS=paseo-next-v2,previewnet bun run build`), re-run only the offline test (`-g "offline banner"`).
Expected: FAIL on `toHaveText`. Revert the change and rebuild.

- [ ] **Step 5: Add the spec to the functional script and commit**

In `apps/host/package.json`, append ` tests/functional/ui-smoke.spec.ts` to the end of the `test:functional` file list.

Run: `bun run format:check && bun run --cwd apps/host lint && bun run --cwd apps/host typecheck`
Expected: PASS.

```bash
git add apps/host/tests/functional/ui-smoke.spec.ts apps/host/package.json
git commit -m "test(host): add shell UI smoke spec for the Solid migration"
```

---

### Task 4: Record the SP4 permission-event note in the umbrella spec

Answers Q5. Docs only.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-25-solid-v2-ui-migration-design.md:189` (the sub-project 4 row)

- [ ] **Step 1: Append the note to the SP4 row**

In the table row that starts `| 4 | Shell + prerender |`, append to the last cell, before the closing `|`:

```text
; unify the `dotli:permission-changed` detail to `{ label, permission }` for both producers (today `PromptPermission` sends `{ label }` and the topbar permissions popover sends `{ label, permission }`)
```

- [ ] **Step 2: Check formatting and commit**

Run: `bun run format:check`
Expected: PASS (run `bunx prettier --write` on the file if the table re-flows, then re-check).

```bash
git add docs/superpowers/specs/2026-09-25-solid-v2-ui-migration-design.md
git commit -m "docs: note permission-changed detail unification for SP4"
```

---

### Task 5: Cold-start A/B, 20 runs each

Answers Q7. Replaces the provisional cold-start verdict with a same-machine, back-to-back comparison of `main` and the branch.

**Files:**
- Modify: `docs/perf/solid-migration-baseline.md` (new section at the end)

Gotchas:
- `bun run test:perf` hard-codes `PERF_RUNS=10` inside the script, so an outer `PERF_RUNS=20` is overridden. Call Playwright directly as below.
- The Playwright `webServer` has `reuseExistingServer: true`. A preview server left running from the other checkout will silently serve the wrong build. Before each run: `lsof -ti tcp:5173 | xargs -r kill`.
- Close other heavy processes; run both measurements back to back.

- [ ] **Step 1: Build `main` in a temporary worktree and measure it**

```bash
BASE=$(git merge-base main HEAD)
git worktree add <scratchpad>/wt-main "$BASE"
cd <scratchpad>/wt-main
bun install --frozen-lockfile
VITE_NETWORKS=paseo-next-v2,previewnet bun run build
lsof -ti tcp:5173 | xargs -r kill
cd apps/host
PERF_RUNS=20 PERF_SAVE_BASE=1 PERF_DOMAIN_A=browse PERF_DOMAIN_B=host-playground npx playwright test --config=tests/performance/playwright.config.ts tests/performance/cold-start.spec.ts
```

Expected: passes; writes `tests/performance/results/base.json` inside the worktree. Record the `Host total` p50, p95 and cv from the output.

- [ ] **Step 2: Measure the branch right after**

```bash
cp <scratchpad>/wt-main/apps/host/tests/performance/results/base.json apps/host/tests/performance/results/base.json
VITE_NETWORKS=paseo-next-v2,previewnet bun run build
lsof -ti tcp:5173 | xargs -r kill
cd apps/host
PERF_RUNS=20 PERF_DOMAIN_A=browse PERF_DOMAIN_B=host-playground npx playwright test --config=tests/performance/playwright.config.ts tests/performance/cold-start.spec.ts
bun tests/performance/compare.ts
```

Expected: passes; record the branch `Host total` p50, p95, cv, and `compare.ts`'s End-to-end verdict (Mann-Whitney z and significance).

- [ ] **Step 3: Remove the worktree**

```bash
lsof -ti tcp:5173 | xargs -r kill
git worktree remove --force <scratchpad>/wt-main
```

Expected: `git worktree list` shows only the main checkout.

- [ ] **Step 4: Record the result**

Append to `docs/perf/solid-migration-baseline.md`:

```markdown
## Cold start A/B (20 runs each)

`main` at `<BASE short hash>` and `feat/solid-v2-foundation` at `<HEAD short hash>`,
built with the same command and measured back to back on the same idle machine
(`PERF_RUNS=20`, Playwright called directly because `test:perf` pins 10 runs).

| Build | Host total p50 | p95 | cv |
|---|---:|---:|---:|
| main | <ms> | <ms> | <cv> |
| branch | <ms> | <ms> | <cv> |

Δ p50: <+/-x.x%>. `compare.ts` End-to-end: <z>, <significant / not significant>.
Gate (no regression beyond 5%): **<pass / fail>**. This replaces the
provisional verdict in "After Solid-free stores" above.
```

Fill every `<…>` with the measured values. Then, in the "After Solid-free stores" → "Cold start" paragraph, change `**pass (provisional; confirm with `PERF_RUNS=20`)**` to `**pass (provisional; superseded by "Cold start A/B" below)**`.

If the gate fails (branch p50 more than 5% slower than main), do not commit a "pass": record the numbers, run the pair once more, and report both pairs to the controller as a blocker.

- [ ] **Step 5: Commit**

```bash
git add docs/perf/solid-migration-baseline.md
git commit -m "docs(perf): record 20-run cold-start A/B for SP0"
```

---

### Task 6: Final verification and hand-off

**Files:**
- Modify: `SOLID_MIGRATION_QUESTIONS.md` (untracked; not committed)

- [ ] **Step 1: Full checks**

Run: `bun run typecheck && bun run lint && bun run format:check && bun run test && bun test scripts/eager-path-size.test.ts`
Expected: all pass.

Run: `VITE_NETWORKS=paseo-next-v2,previewnet bun run build && bun run --cwd apps/host test:functional`
Expected: previous 35 passed / 2 skipped, plus the 6 new smoke tests passed.

- [ ] **Step 2: Update the questions file**

In `SOLID_MIGRATION_QUESTIONS.md`, mark each "Your answers" row that this plan acted on as done with its commit hash; update "Branch state" to the new commit count (`git rev-list --count main..HEAD`); remove the follow-ups this plan closed (PERF_RUNS=20, CI eager budget, topbar import, setter name).

- [ ] **Step 3: Hand the owner the remaining manual pass**

These are the checks the smoke spec cannot make. Put them in the final report to the owner, not in a file:
- Scan the login QR with Polkadot Mobile and see pairing complete (the spec only checks the modal opens and closes).
- Look at the landing page, topbar and a toast in light and dark themes (the spec checks attributes, not how things look).
- Open a real `.dot` name in a normal browser profile and use it for a minute.

Then ask the owner whether to push the branch and open the single PR (Q1). Do not push without that answer.
