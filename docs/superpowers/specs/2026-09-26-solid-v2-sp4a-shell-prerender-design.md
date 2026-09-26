# Solid v2 migration — sub-project 4a: shell prerender and hydration

Status: the owner accepted the SP3/SP4 recommendation on 2026-09-26 (error
pages stay imperative, SP4 before SP3, host limit +25 KB, sandbox Solid-free at
startup). The split of SP4 into 4a–4d and the decisions below are the
controller's, recorded in `SOLID_MIGRATION_QUESTIONS.md`. Parent:
`2026-09-25-solid-v2-ui-migration-design.md` (sub-project 4).

## Sub-project 4 split

| Part | Contents | Depends on |
|---|---|---|
| **4a** (this spec) | Prerender plugin + hydration of the host shell as a static `Shell` component; imperative topbar code keeps working on the hydrated DOM | — |
| 4b | Theme toggle/popover, verification shield, URL pill, offline banner as components; shared popover behaviour (outside click, Escape, focus trap) | 4a |
| 4c | Auth button + QR pairing modal + user popover + permissions popover; unify the `dotli:permission-changed` detail to `{ label, permission }` | 4a, 4b (popover behaviour) |
| 4d | Network/chains, settings/diagnostics, topbar autohide, and `product-frame-layout.ts` consolidating every product-iframe geometry write (fixing the unreconciled chat-width vs autohide write) | 4a–4c |

Each part gets its own spec and plan. 4b–4d replace pieces of the static
`Shell` with reactive components and delete the matching imperative code.

## Goal (4a)

The shell markup that is static HTML in `apps/host/index.html` today (the
topbar, the popovers, the QR pairing modal and the backdrops, lines 76–311 at
the time of writing) is rendered at build time from a Solid component and
hydrated in the browser. Nothing a person sees or can do changes: same markup,
same first paint (visible with JavaScript disabled), and the existing
imperative topbar code still finds and wires the same elements, now owned by a
hydrated root.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Container | The shell block moves into `<div id="shell" style="display: contents">` in `index.html`, whose content is the prerender placeholder `<!--ssr:shell-->`. `display: contents` keeps every child a layout child of `body` (no CSS uses `body >` selectors) |
| 2 | Component | `packages/ui/src/components/shell/Shell.tsx` renders exactly today's markup as static JSX (ids, classes, attributes, inline SVGs, text). No reactivity in 4a |
| 3 | Prerender | A local Vite plugin, `packages/ui/src/mount/prerender-plugin.ts`, loads a server entry (`packages/ui/src/components/shell/shell.server.tsx`, exporting `renderShell(): string` via `renderToString(() => <Shell/>, { renderId: "shell" })`) through Vite's SSR module loading and replaces `<!--ssr:shell-->` in `transformIndexHtml`, in both `vite dev` and `vite build` |
| 4 | Hydration | `packages/ui/src/mount/hydrate-shell.tsx` exports `hydrateShell(): void`, called by `apps/host/src/main.ts` before `initTopBar`. It calls `hydrate(() => <Shell/>, #shell, { renderId: "shell" })` inside the root registry (`mountRoot`'s Errored/Sentry reporting applies) |
| 5 | Failure | If hydration throws, report to Sentry, clear `#shell`, and `render()` the same component, so the page still has a working shell (a breadcrumb records it) |
| 6 | Budget | Solid's runtime enters the host startup path here (expected ~15–17 KB gzip); the amended umbrella limit is +25 KB for the whole migration. The sandbox is untouched |
| 7 | Chat root | The umbrella's `chat` prerender root is dropped: after SP2 the chat container is empty and the panel loads lazily |

## Testing

- Markup fidelity: parse the original shell block (from `git show` of
  `index.html` before 4a, stored as a test fixture) and the `renderShell()`
  output; normalized DOM trees (attribute order ignored, whitespace between
  tags ignored, hydration markers stripped) are equal.
- Hydration: inject `renderShell()` into `#shell` in happy-dom, hydrate, and
  assert no hydration mismatch warning, the same element nodes before and
  after hydration (identity by id), and that a click handler attached
  imperatively after hydration fires.
- Failure path: a hydration error falls back to `render()` and the shell
  exists.
- Plugin: unit-test the HTML transform with a stub renderer (placeholder
  replaced once; missing placeholder is an error at build time).
- Playwright: the shell (`#topbar`, `#auth-button`) is present with
  JavaScript disabled; the functional suite passes unchanged.

## Performance gates

| Metric | Gate |
|---|---|
| Host startup gzip | growth recorded; must keep the whole-migration total within +25 KB |
| Sandbox startup | unchanged |
| Cold start (20-run A/B vs the branch before 4a) | no regression beyond 5% |
| First paint | shell present with JS disabled |

## Done when

The shell renders from `Shell.tsx` via prerender + hydration, `index.html`
holds only the placeholder container for it, all tests and gates pass, and the
results are recorded in `docs/perf/solid-migration-baseline.md`.
