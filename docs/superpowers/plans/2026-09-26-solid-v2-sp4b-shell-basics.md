# Solid v2 SP4b — theme, URL pill, shield, offline banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the theme toggle, URL pill + verification shield, and offline banner in the hydrated `Shell` into reactive Solid components with a shared popover primitive, deleting the matching imperative code, with no visible change.

**Architecture:** Solid-free controllers/stores (`theme-controller.ts`, `state/url-pill.ts`) own browser state and are what `main.ts` and other non-UI code call. Components in `packages/ui/src/components/shell/` read stores via `useStore`, render today's markup, and are placed inside `Shell.tsx` so they prerender and hydrate.

**Tech Stack:** Solid 2 RC, Vitest (the `ui` and `hydration` projects in `packages/ui/vitest.config.ts`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-26-solid-v2-sp4b-shell-basics-design.md`.

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push.
- Markup, ids, classes, `aria-*`, titles and copy of each piece are unchanged (compare with `git show` of `Shell.tsx`, `verification-shield.ts`, `offline.ts` and the `#topbar-url` writes in `apps/host/src/main.ts` before this plan). The only intended markup change is the offline banner appearing in the prerendered HTML.
- Non-UI code never imports `solid-js`; `main.ts` talks to the new stores/controllers only. The sandbox is untouched.
- Components render store defaults on the server and first client pass; browser values are applied after hydration.
- Product-derived strings render as JSX text (no `innerHTML`). Host-constant SVG may use `innerHTML` with `// eslint-disable-next-line solid/no-innerhtml -- trusted SVG from host code`, or plain JSX SVG.
- Solid idioms/lint in this repo: callback refs, `untrack(() => props.x)` for one-time reads, `String(n)` for numeric text, `eqeqeq`; no Solid dev warnings (`cd packages/ui && NODE_OPTIONS=--no-experimental-webstorage bunx vitest run --reporter=default --silent=false`); hydration tests go in the `hydration` Vitest project (add file paths to `HYDRATION_TESTS`).
- Every commit passes `bun run typecheck`, `bun run lint`, `bun run test`; `bunx prettier --check` on changed `.ts`/`.tsx`.

## Review Focus

1. Theme preference applied before paint still comes from the inline bootstrap script; the controller must not flash a different theme after hydration. Pinned in Task 2 (controller reads the same key and resolves identically).
2. A domain containing markup must render as text in the URL pill. Pinned in Task 3.
3. The shield tooltip must close on window blur (cross-origin iframe taps) and on a blocking modal. Pinned in Task 3.
4. Autohide detects open surfaces by id and `.open`; the shield tooltip and theme popover must keep both. Pinned in Tasks 2–3 (assert class and id).
5. Offline banner hidden when the topbar is hidden, shown again when it returns while offline. Pinned in Task 4.

---

### Task 1: Popover primitive and island plumbing

**Files:** Create `packages/ui/src/components/shell/popover.ts` (`createPopover(options: { trigger: () => HTMLElement | undefined; surface: () => HTMLElement | undefined; trapFocus?: boolean; onClose?: () => void }): { open: Accessor<boolean>; setOpen(open: boolean): void; toggle(): void }`), test `packages/ui/tests/components/shell/popover.test.tsx`.

Behaviour: outside click (document `click`, target outside trigger and surface) closes; Escape closes and returns focus to the trigger when focus was inside the surface or on `body`; `window` `blur` closes when `closeOnBlur` is set (add that option); closes when `topbarStore.get().blockingModalActive` becomes true; optional focus trap equivalent to `topbar.ts`'s `trapPopoverFocus` (read it). All listeners removed on cleanup. Tests cover each rule.

Also in this task (island plumbing, spec decisions 10–11): add `components/shell/Island.tsx` — `Island(props: { name: string; children: JSX.Element })` wrapping children in an `Errored` whose fallback renders nothing and reports to Sentry once with `{ root: "shell", island: name }`; it must compile identically on server and client so hydration keys align (follow `mount/hydration-boundary.ts`). Widen the strip plugin's allowlist (`packages/ui/src/mount/strip-client-templates-plugin.ts`) to exactly the imports an `<Island name="x"><Child/></Island>` insertion compiles to in `Shell.tsx` (verify by compiling a probe), keeping static-template stripping and the `buildEnd` guard; add tests: a Shell-like fixture with one island still strips its static templates, and a Shell with a `<Show>`/`<For>` still fails the build.

- [ ] Tests first; implement; checks; commit `feat(ui): add a shared shell popover primitive and island boundary`.

### Task 2: Theme controller and ThemeToggle

**Files:** Create `packages/ui/src/theme-controller.ts` (`initTheme(): void`, `selectThemePref(pref: ThemePref): void`, moving `getStoredThemePref`, `resolveTheme`, `applyThemePref`, the `matchMedia` listener from `topbar.ts` unchanged), `packages/ui/src/components/shell/ThemeToggle.tsx`; modify `Shell.tsx` (replace the static `#theme-toggle`/`#theme-popover` markup with `<ThemeToggle/>`), `topbar.ts` (remove theme code and theme handling from the shared outside-click closer and the blocking-modal handler; `initTopBar` calls `initTheme()` or `main.ts` does — keep today's timing), tests `packages/ui/tests/theme-controller.test.ts`, `packages/ui/tests/components/shell/theme-toggle.test.tsx`, and a hydration test; update `packages/ui/tests/topbar.test.ts` theme tests to the new component/controller (behaviour assertions unchanged).

ThemeToggle: button `#theme-toggle` (title/aria-label "Theme: Light|Dark|System" from the store's pref, `aria-haspopup="menu"`, `aria-expanded`, the three icons unchanged), popover `#theme-popover.more-popover.theme-popover` (`role="menu"`, `aria-label="Theme"`, `.open` when open), options `.more-row.theme-popover-option` `role="menuitemradio"` `aria-checked` from the store, `data-theme-option`, `tabindex="-1"`; menu-button keyboard pattern from `topbar.ts` (focus checked option on open; ↑/↓ wrap, Home/End; Escape closes and focuses the button; Tab closes); selecting calls `selectThemePref` and closes, focusing the button. Uses `createPopover`. The mobile "more" row that forwards a click to `#theme-toggle` must keep working (it calls `.click()` on the button).

- [ ] Tests first; implement; the Playwright theme test in `ui-smoke.spec.ts` must still pass (run after a build, or leave to Task 5 but say so); checks; commit `feat(ui): render the theme toggle with Solid`.

### Task 3: URL pill and verification shield

**Files:** Create `packages/ui/src/state/url-pill.ts` (store + setters: `showLocalhostPill(host: string)`, `showProductPill(domain: string, tld: string)`, `setVerificationShieldState(state: ShieldState)` — re-exported from `verification-shield.ts` under the same name — and `resetUrlPill()`), `components/shell/UrlPill.tsx`, `components/shell/VerificationShield.tsx`; modify `Shell.tsx` (`#topbar-url` renders `<UrlPill/>`), `verification-shield.ts` (keep exported constants/types and `setVerificationShieldState`; delete `verificationShieldMarkup`/`bindVerificationShield` DOM code), `apps/host/src/main.ts` (replace the three `urlBar.innerHTML = …` writes and the `bindVerificationShield()` call with store setters; keep the `#topbar-url` invariant check and its `showError`/Sentry behaviour; keep `setShieldState`'s autohide arming), tests `packages/ui/tests/components/shell/url-pill.test.tsx` and a hydration test; rewrite `packages/ui/tests/verification-shield.test.ts` against the component (same behaviours).

Markup: read the three variants in `main.ts` (localhost pill with link/monitor SVG and `.dot-domain`; product pill `#url-pill` with the shield markup and `.topbar-url-text` > `.dot-domain` + `.dot-tld`) and `verificationShieldMarkup()`; reproduce exactly. The shield uses `createPopover` with `closeOnBlur`, and the tooltip keeps `id="verification-tooltip"` and the `.open` class.

- [ ] Tests first (including a domain `<b>x</b>` rendered as text); implement; checks; commit `feat(ui): render the URL pill and verification shield with Solid`.

### Task 4: Offline banner

**Files:** Create `components/shell/OfflineBanner.tsx`; modify `Shell.tsx` (render `<OfflineBanner/>` as the last child of `#topbar`); delete `apps/host/src/offline.ts` and its import in `main.ts`/`boot.ts`; update the 4a fidelity fixture for the banner's presence (document why in the test); tests `packages/ui/tests/components/shell/offline-banner.test.tsx` and a hydration test.

Behaviour: `#offline-banner`, `role="status"`, `aria-live="polite"`, text "You are offline", today's inline style values (absolute under the topbar), `display` block when `navigator.onLine` is false and `topbarStore.get().topbarVisible` is true, else none; listens to `online`/`offline`; server/first render shows `display: none`.

- [ ] Tests first; implement; checks; commit `feat(ui): render the offline banner with Solid`.

### Task 5: Keep components alive on the hydration fallback path

**Files:** modify `packages/ui/src/mount/hydrate-shell.tsx` / `root.ts` (4a's snapshot-restore fallback); tests in the `hydration` Vitest project.

After 4a's size fix, a failed shell hydration restores a snapshot of the prerendered shell, which leaves reactive components inert. On `data-hydrated="fallback"`, mount each 4b component (ThemeToggle, UrlPill, OfflineBanner) with `render()` into its own element inside the restored snapshot, replacing that element's static copy; import the component modules lazily so the startup bundle does not grow (measure). Test: force a mismatch, assert the theme toggle opens and selects, the URL pill follows its store, the shield tooltip toggles, and the offline banner responds to `offline`.

- [ ] Tests first; implement; checks; commit `fix(ui): keep shell components working after a hydration fallback`.

### Task 6: Verify

- [ ] Build (`VITE_NETWORKS=paseo-next-v2,previewnet bun run build`), functional suite (background, port 5173 freed): all pass (including the theme, offline, QR and hydration tests in `ui-smoke.spec.ts`).
- [ ] Sizes vs the end of 4a (build the 4a end commit in a temporary worktree): host startup ≤ +1,024 B gzip and the running total under +25,600 B over the pre-migration 74,649 B; sandbox unchanged. Cold start 20-run A/B: ≤ +5% on `Host total`.
- [ ] Record an "After sub-project 4b" section in `docs/perf/solid-migration-baseline.md`; commit `docs(perf): record sub-project 4b sizes and cold start`.

---

## Amendment (2026-09-26): lazy islands (spec decisions 14–18)

Tasks 1 and 2 are done (665540bb, f4c9109f, 322ff937). The remaining work is below; where Tasks 3–5 above conflict with it, this section wins.

### Task 2b: Switch to lazy islands

**Files:**
- **Create:** `packages/ui/src/mount/load-islands.ts`, `packages/ui/src/components/shell/islands.tsx`, and tests `packages/ui/tests/mount/load-islands.test.ts` and `packages/ui/tests/components/shell/islands.test.tsx`.
- **Modify:**
  - `Shell.tsx`: restore the static theme markup exactly as at f4c9109f.
  - `apps/host/src/boot.ts`: add `void ensureIslands()` after `hydrateShell()`.
  - `strip-client-templates-plugin.ts`: revert the allowlist to the 4a set, and delete the island-only fixtures and tests. Keep the `<Show>`/`<For>` rejection tests, and keep the `<script` guard in `render-hydratable.ts` with its tests.
  - `packages/ui/vitest.config.ts`.
- **Delete:** `Island.tsx` and the theme-toggle hydration test. Replace the hydration test with swap tests per spec decision 18.

Reference: throwaway spike commit 17e94b82 on branch `spike/lazy-islands`. Read it, but do not cherry-pick blindly.

**The loader:**
- It is memoized and never rejects.
- It installs the early-click capture for trigger ids (decision 15) and replays after the swap.
- On a chunk failure it removes the capture and reports once to Sentry, as `overlays/load.ts` does.

**The chunk:**
- It exports `mountIslands(): void`, which mounts the theme island and swaps `#theme-toggle` and `#theme-popover`.
- Focus is carried over.
- Failures leave the static nodes in place.

**Tests:**
- Swap in place, including after a node has moved outside `#shell`.
- Exactly one element per id.
- Early click replay: a click before the mount opens the popover after it.
- Chunk failure leaves the static nodes and captures nothing afterwards.
- An island render error keeps the static nodes and reports once.

**Also** fix the Task 2 review's surviving Minor findings (`.superpowers/sdd/.../task-2-review.md`).

**Measure host startup:** it must stay ≤ 97,512 + 200 B.

- [ ] Tests first; implement; checks; commit `refactor(ui): mount shell islands lazily after boot`.

### Tasks 3–4 (amended)

- Each component is added to `islands.tsx`'s mount list. `Shell.tsx` keeps (or, for the offline banner, gains) the static markup. There are no hydration tests; write swap tests instead.
- Task 3: `main.ts` may write the url-pill store before the island mounts. The island must render the store's current value on mount.
- Task 3: the store's default must match the static markup, so the swap shows no flash.
- Task 4: the offline banner's static markup is hidden (`display: none`). The island applies the real state on mount.

### Task 5 (amended)

- Force a hydration mismatch.
- Then run `ensureIslands()`.
- Assert that the theme toggle, URL pill, shield and offline banner all work.
- No other production change is expected.

### Task 6

This task is unchanged, except for the budget: host startup must be ≤ 97,512 + 1,024 B.
