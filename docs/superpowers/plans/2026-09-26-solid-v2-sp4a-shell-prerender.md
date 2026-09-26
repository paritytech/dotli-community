# Solid v2 SP4a — shell prerender and hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the host shell (topbar, popovers, QR modal, backdrops) from a static Solid component prerendered into `index.html` at dev and build time, and hydrate it in the browser, with no visible or behavioural change.

**Architecture:** `Shell.tsx` mirrors today's markup; `shell.server.tsx` renders it with `renderToString(..., { renderId: "shell" })`; a Vite plugin swaps `<!--ssr:shell-->` for that HTML; `hydrateShell()` hydrates `#shell` before `initTopBar`, which keeps wiring the same DOM.

**Tech Stack:** Vite 8 plugins (`transformIndexHtml`, SSR module loading), `@solidjs/vite-plugin` (`ssr: true`), `@solidjs/web` `renderToString` / `hydrate` (2.0.0-rc.9), Vitest + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-26-solid-v2-sp4a-shell-prerender-design.md`.

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push.
- Markup is a frozen contract: every id, class, attribute, inline SVG and text node of the shell block must be identical after prerender (the fidelity test is the arbiter). Playwright selectors `#auth-button`, `.user-badge`, `#auth-modal-qr canvas`, `#user-popover-username` keep working.
- `packages/ui/src/topbar.ts` and other imperative shell code are not changed in 4a beyond what hydration strictly requires (ideally nothing).
- The sandbox app and its bundle are untouched.
- Solid idioms and lint rules used in this repo: callback refs, `untrack` for deliberate one-time reads, `String(n)` for numeric text, `eqeqeq`, and no Solid dev warnings in test output (check with `cd packages/ui && NODE_OPTIONS=--no-experimental-webstorage bunx vitest run --reporter=default --silent=false`; the default reporter here hides them).
- Every commit passes `bun run typecheck`, `bun run lint`, `bun run test`; `bunx prettier --check` on changed `.ts`/`.tsx`.

## Review Focus

1. Build-time rendering must fail the build loudly if the placeholder or the server entry is missing, never ship an empty shell. Pinned in Task 1.
2. A hydration mismatch (for example a store default that differs from the prerendered HTML) must be detected in tests, not discovered in production. Pinned in Task 3.
3. Imperative code that cached element references before hydration would break; the plan calls `hydrateShell()` before any shell code runs. Pinned in Task 3 by node-identity and handler tests, and in Task 4 by the functional suite.
4. First paint with JavaScript disabled must still show the shell. Pinned in Task 4.
5. The theme bootstrap script (inline, before the shell) must still set `data-theme` before paint. Pinned in Task 4 (no change to it; check the order in `index.html`).

---

### Task 1: Prerender plumbing spike (placeholder component)

**Files:** Create `packages/ui/src/mount/prerender-plugin.ts`, `packages/ui/src/components/shell/shell.server.tsx` (temporarily rendering a tiny placeholder component), a test `packages/ui/tests/mount/prerender-plugin.test.ts`; modify `apps/host/vite.config.ts` (add the plugin) and `apps/host/index.html` (add `<div id="shell" style="display: contents"><!--ssr:shell--></div>` right after the existing shell block for now, so nothing visible changes yet).

**What to build:** `prerenderPlugin(options: { placeholder: string; entry: string; exportName: string }): Plugin`. In `vite dev`, use the dev server's SSR module loading; in `vite build`, create an SSR-capable Vite server (middleware mode, same config/plugins, `appType: "custom"`) or an equivalent supported mechanism, load the entry, call the export, and replace the placeholder in `transformIndexHtml`; close any server it created. The render function's output is inserted verbatim. Missing placeholder or entry → throw with a clear message (build fails). Keep the HTML-transform logic a pure exported function (`injectPrerendered(html, placeholder, rendered)`) and unit-test it (replaced once; missing placeholder throws; placeholder appearing twice throws).

- [ ] Step 1: Write the pure transform + tests; implement the plugin.
- [ ] Step 2: Prove it works: `VITE_NETWORKS=paseo-next-v2,previewnet bun run build` → `apps/host/dist/index.html` contains the placeholder component's rendered HTML inside `#shell` (with Solid hydration markers). Also run `bun run --cwd apps/host dev` briefly (background, then `curl -s http://localhost:<port>/ | grep` for the rendered HTML), then stop it. If either path cannot be made to work with Vite 8 + `@solidjs/vite-plugin` 3.0.0-next.44, stop and report BLOCKED with what you tried — do not proceed to hand-written workarounds that bypass Vite's SSR transform (the server render must compile JSX in SSR mode).
- [ ] Step 3: Checks pass; commit `feat(host): add a shell prerender plugin`.

### Task 2: Static Shell component and fidelity test

**Files:** Create `packages/ui/src/components/shell/Shell.tsx`; make `shell.server.tsx` render `<Shell/>` with `renderId: "shell"`; create `packages/ui/tests/components/shell/fidelity.test.ts` and a fixture `packages/ui/tests/components/shell/original-shell.html` (the exact shell block from `apps/host/index.html` at the commit before this task: the lines from `<!-- Top Bar -->` through the end of the permissions popover, before the chat `aside`); modify `apps/host/index.html` to remove that block and keep only `<div id="shell" style="display: contents"><!--ssr:shell--></div>` in its place (the chat aside, `#app` and scripts stay).

**What to build:** `Shell.tsx` as static JSX reproducing the fixture exactly (convert `class`, keep SVG attributes, `aria-*`, `data-*`, `hidden`, inline `style` strings; keep HTML comments out — they are not part of the DOM contract). The fidelity test parses the fixture and `renderShell()`'s output into DOM trees (happy-dom `DOMParser` or a template element), strips Solid hydration attributes/markers, and compares a normalized serialization (element names, attribute sets with values, text content trimmed, child order).

- [ ] Step 1: Write the fixture and the fidelity test (fails: Shell missing).
- [ ] Step 2: Write `Shell.tsx` until the test passes. Update `index.html`.
- [ ] Step 3: Build and confirm `apps/host/dist/index.html` has the prerendered shell in `#shell`. Checks pass; commit `feat(ui): prerender the host shell from a static Solid component`.

### Task 3: Hydration

**Files:** Create `packages/ui/src/mount/hydrate-shell.tsx` (`hydrateShell(): void`); modify `apps/host/src/main.ts` to call it before `initTopBar` (and before anything else that queries shell elements — check the order in `main.ts`); if `mountRoot` cannot wrap `hydrate`, add a sibling helper in `mount/root.ts` (`hydrateRoot(name, container, view, options)`) with the same Errored + Sentry-once behaviour; tests `packages/ui/tests/mount/hydrate-shell.test.tsx`.

**What to build:** hydrate `#shell` with `renderId: "shell"`; on throw, capture to Sentry (`{ root: "shell", kind: "hydration_failed" }`), clear the container, `render()` the same view. Tests: (a) inject `renderShell()` output, hydrate, assert no console warning/error containing "hydrat" and same element identity for `#topbar`, `#auth-button`, `#theme-toggle`, `#chat-button` before/after; (b) attach a click listener to `#auth-button` after hydration and assert it fires; (c) force a mismatch (inject different HTML) and assert the fallback renders a working shell and Sentry was called.

- [ ] Step 1: Tests first; implement.
- [ ] Step 2: `bun run test` and the Solid dev-warning check are clean; commit `feat(host): hydrate the prerendered shell`.

### Task 4: Gates and verification

- [ ] Step 1: Playwright: add a test to `apps/host/tests/functional/ui-smoke.spec.ts` that opens the landing page with JavaScript disabled (`browser.newContext({ javaScriptEnabled: false })`) and asserts `#topbar` and `#auth-button` are in the DOM (the topbar is hidden on the landing page by JS, so with JS off it is present). Run the whole functional suite (background, port 5173 freed first): all previous tests pass plus the new one.
- [ ] Step 2: Sizes: host and sandbox `bun scripts/eager-path-size.ts` before (build the commit before Task 1 in a temporary worktree) and after; the sourcemap `sources` check now expects Solid in the host startup path — record which chunks; sandbox startup must be unchanged (±50 B) with no Solid.
- [ ] Step 3: Cold-start A/B, 20 runs each (same procedure as `docs/perf/solid-migration-baseline.md` "After sub-project 2"): no regression beyond 5% on `Host total`.
- [ ] Step 4: Record an "After sub-project 4a" section in `docs/perf/solid-migration-baseline.md` (host/sandbox startup before/after, running total vs the pre-migration baseline 74,649 B and the +25 KB limit, Solid chunks, cold start). Commit `docs(perf): record sub-project 4a sizes and cold start`.
