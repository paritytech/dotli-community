# Solid v2 migration — sub-project 4b: theme, URL pill, verification shield, offline banner

Status: controller-written under the owner's standing instruction (2026-09-26:
"go with your recommendation for SP3 and SP4", continue while AFK). Parent:
`2026-09-26-solid-v2-sp4a-shell-prerender-design.md` (4a: static `Shell`
prerendered and hydrated; imperative topbar code wires the hydrated DOM).

## Goal

Replace four pieces of the static `Shell` and their imperative code with
reactive Solid components that hydrate from the prerendered HTML: the theme
toggle and popover, the URL pill (plain localhost variant and product variant
with the verification shield and its tooltip), and the offline banner. Add one
shared popover primitive that 4c/4d reuse. No visible change.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Theme | A Solid-free `packages/ui/src/theme-controller.ts` owns the stored preference (`localStorage["dotli-theme"]`), `matchMedia` following, the `<html>` `data-theme-pref`/`data-theme` writes and `setTheme` (moved from `topbar.ts`, behaviour identical). `components/shell/ThemeToggle.tsx` renders `#theme-toggle` + `#theme-popover` from `themeStore`, with today's menu-button keyboard pattern (focus the checked option on open, ↑/↓/Home/End, Escape returns focus, Tab closes) |
| 2 | URL pill | `main.ts` stops writing `#topbar-url` `innerHTML`; it calls setters on a new Solid-free `state/url-pill.ts` store (`{ kind: "none" } \| { kind: "localhost", host } \| { kind: "product", domain, tld, shield: ShieldState \| null }`). `components/shell/UrlPill.tsx` renders the same markup as today's three variants (`.topbar-url-pill`, `.localhost-pill`, `#url-pill`, `.dot-domain`, `.dot-tld`, `.topbar-url-text`). Domain and TLD render as JSX text (today `escapeHtml` + `innerHTML`). The main.ts DOM-invariant check on `#topbar-url` stays |
| 3 | Shield | `components/shell/VerificationShield.tsx` renders today's `verificationShieldMarkup()` exactly (ids `verification-shield`, `verification-tooltip`, classes, both icon variants, `.is-current` row, `aria-*`), open state local, closing on outside click, Escape (focus back to the button when focus was inside or on body), window blur, and the blocking-modal-active store flag. `setVerificationShieldState(state)` keeps its name and signature and writes the url-pill store; `verification-shield.ts` keeps its exported constants and types, loses its DOM code |
| 4 | Offline | `components/shell/OfflineBanner.tsx` renders `#offline-banner` inside `#topbar` with today's `role="status"`, `aria-live="polite"`, text and inline style, shown when offline and the topbar is visible (`topbarStore`). `apps/host/src/offline.ts` is deleted (its import-time side effect goes away). The banner is now in the prerendered HTML, hidden |
| 5 | Popover primitive | `components/shell/popover.ts` exports `createPopover(options)`: open signal, outside-click close (document click, ignoring the trigger and surface), Escape close with focus return, optional focus trap, close when `topbarStore.blockingModalActive` becomes true. ThemeToggle and VerificationShield use it; `topbar.ts`'s shared outside-click closer and blocking-modal handler drop the theme popover. `topbar-autohide.ts`'s id-string lists stay valid (ids unchanged, `.open` class unchanged) |
| 6 | Hydration safety | Components render store defaults on the server and first client pass (theme pref "system", url-pill "none", online) and apply browser values after hydration, so prerendered and hydrated markup match. Because 4a's mismatch check only compares top-level shell elements, 4b adds a hydration test per component asserting subtree node identity and no Solid hydration warning |
| 8 | Hydration fallback | After 4a's size fix, a failed shell hydration restores a snapshot of the prerendered shell (valid only while it is static). 4b's reactive components must still work on that path: on fallback, client-render each 4b component into its own element (lazy import of the component module) or re-run hydration for just those subtrees; a test forces the fallback and checks the theme toggle, URL pill, shield and offline banner still work |
| 9 | Budget | The host startup total after 4a is about +22.8 KB over the pre-migration baseline against the owner's +25 KB limit. 4b must stay within about +1 KB net (it deletes imperative theme/shield/offline code); if it cannot, stop and ask the owner before exceeding the limit |
| 10 | Template stripping | 4a's client-only strip plugin (`packages/ui/src/mount/strip-client-templates-plugin.ts`) fails the build as soon as `Shell.tsx` imports anything but `template`/`getNextElement`/`claimElement`. 4b keeps `Shell.tsx` itself free of control flow and renders islands only as child components; widen the allowlist to exactly what an island insertion compiles to (`createComponent`, and `insert`/`memo` only if needed), keep stripping the static templates, and keep the `buildEnd` guard. Each island module keeps its own templates (they are needed for the fallback client render) |
| 11 | Per-island error boundaries | 4a's outer hydration boundary renders `null` on any error, so one island error after hydration would blank the whole shell. Wrap each island in its own `Errored` inside `Shell.tsx`, on both server and client (keys stay aligned), reporting to Sentry once with `{ root: "shell", island: <name> }`; the outer boundary remains only the hydration-failure net |
| 12 | No serialized async state | The prerender is a fragment with no hydration/serialization script. Islands must not depend on server-serialized async data or `Loading` resolution |
| 13 | Render id prefixes | Solid matches hydration keys by prefix; no future root id may start with `shell` |
| 7 | Fidelity | The 4a fidelity fixture is updated deliberately for the one intended markup change (the offline banner now present in the prerender); every other node must still match |

## Testing

Component tests for each piece (markup, keyboard, outside click, Escape, blur,
blocking modal, store-driven variants, text-only rendering of domain/TLD);
theme-controller unit tests (stored pref, system following, `<html>` attrs,
`setTheme` + `dotli:theme-changed`); hydration tests per component; existing
`topbar.test.ts` theme tests and `verification-shield.test.ts` rewritten
against the new components; the functional suite (theme and offline tests in
`ui-smoke.spec.ts`) passes unchanged; Solid dev-warning check clean.

## Performance

Host startup bundle at most +1 KB gzip net versus the end of 4a, and the running total must stay under the owner's +25 KB limit; cold start no
regression beyond 5%.

## Done when

The four pieces render from components, their imperative code is gone
(`offline.ts` deleted, theme code out of `topbar.ts`, shield DOM code out of
`verification-shield.ts`, `innerHTML` writes to `#topbar-url` out of
`main.ts`), all tests and gates pass, results recorded.
