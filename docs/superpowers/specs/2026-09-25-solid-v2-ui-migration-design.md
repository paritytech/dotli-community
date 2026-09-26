# Solid.js v2 UI migration — umbrella design

Status: approved in brainstorming, 2026-09-25. Each sub-project below gets its
own spec, plan, and PR. This document fixes the decisions they all share.

## Goal

Full modernization of the dotli UI: every piece of rendered UI in the host,
sandbox, and dev tooling moves from imperative DOM code to Solid.js v2
components backed by signal stores. The static markup in `apps/host/index.html`
is replaced by components that are prerendered at build time and hydrated in
the browser, so first paint is unchanged.

Out of scope: `apps/protocol` (no UI), restyling (CSS stays as is), new
features.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Full: topbar, auth/QR, popovers, landing, loading page, chat, toasts, modals, truapi-debug panel, sandbox-checker panel, static host markup. **Error pages (host and sandbox) stay imperative** (amended 2026-09-26, owner decision): they are the failure UI and must render even when no chunk can load |
| Solid version | Ship on 2.0 RC, **pinned exact** (`solid-js`, `@solidjs/web`, `@solidjs/signals` `2.0.0-rc.9`; `@solidjs/vite-plugin` `3.0.0-next.44`; `@solidjs/testing-library` `1.0.0-beta.3`). Bumps land in their own `chore:` PRs |
| Delivery | Foundation first, then one area per sub-project, each merged to `main` and shipped |
| CSS | Keep the global stylesheets in `packages/ui/src/styles/`. Components emit the same class names and ids. CSS cleanup is a separate future project |
| State | Typed signal stores in `packages/ui/src/state/`. Producers call store setters. Window events are kept only while something outside the UI still listens |
| First paint | Build-time prerender (`renderToString`) of the host shell, chat shell, and loading screen into `index.html`, then `hydrate` in the browser |
| Plugin mode | `@solidjs/vite-plugin` without `start` mode. Host: `ssr: true` (hydratable output). Sandbox: default client output |

## Architecture

### Tooling

- `packages/typescript-config/solid.json` adds `"jsx": "preserve"` and
  `"jsxImportSource": "@solidjs/web"` (the JSX runtime ships in `@solidjs/web` in Solid 2). Only UI-rendering packages extend it.
- Host and sandbox `vite.config.ts` and the `packages/ui`, `apps/host`, and
  `apps/sandbox` Vitest configs add the Solid plugin.
- `packages/eslint-config` gets a `**/*.tsx` block (Solid lint rules where the
  plugin supports Solid 2; `explicit-function-return-type` relaxed for
  components).

### Layout in `packages/ui/src`

```
state/        signal stores
components/   .tsx components by area (topbar/, chat/, modals/, toasts/, pages/)
mount/        overlay root helper, hydration entry, prerender plugin + server entry
```

Existing public functions (`showNotification`, `showPermissionRequestModal`,
`showError`, `initTopBar`, ...) keep their names and signatures and become thin
wrappers over components and stores. Old modules are deleted as each area
moves.

### State stores

One module per area: `auth`, `product`, `permissions`, `chat`, `network`,
`settings`, `theme`, `topbar`. Each exports:

- a readable store object `{ get, subscribe }` (e.g. `authStore`),
- a synchronous getter, for non-UI code,
- a setter, which is the only writer.

Stores are **Solid-free** (amended 2026-09-25 after sub-project 0 measured
+9.8 KB gzip on the host and +9.5 KB on the sandbox eager paths from
`@solidjs/signals`): `createSyncStore` is a plain value plus a listener set.
Components turn a store into a Solid accessor with
`useStore(store)` from `packages/ui/src/components/use-store.ts`, which creates a
signal, subscribes, and unsubscribes on cleanup. Solid therefore enters a bundle
only with the first component that reads a store. Reading `get()` is always
current; a component's accessor updates after Solid's flush.

Non-UI code never imports `solid-js`. `network-monitor.ts` keeps
`subscribeNetwork`; the network store subscribes to it. The settings store is
seeded from the `config/mode` and `config/network` getters after hydration;
settings changes still go through the apply-and-reload path, so `config` needs
no change hooks. Producers outside `packages/ui` (`shared/chat-capability.ts`)
keep their events and the store listens, preserving package dependency
direction.

Events always kept: `dotli:truapi-auth-state` (e2e global setup listens) and the
command events (`dotli:request-login`, `dotli:truapi-login-request`,
`dotli:truapi-cancel-login`, `dotli:truapi-disconnect-request`). Every other
`dotli:*` / `topbar:*` event is dispatched by its store setter until a grep shows
no non-UI listener, then removed in the sub-project that made it redundant.

Every store starts from a fixed default that matches the prerendered HTML.
Browser-only values (session, localStorage, `matchMedia`) are written after
`hydrate()` returns.

### Roots

| Root | Container | Mount | Sub-project |
|---|---|---|---|
| `shell` | `#topbar` + auth modal + popovers | prerender + `hydrate`, `renderId: "shell"` | 4 |
| `chat` | `aside#chat-panel` | `render` in 2, prerender + `hydrate` (`renderId: "chat"`) in 4 | 2, 4 |
| `loading` | `#app > .loading` | prerender + `hydrate`, `renderId: "loading"` | 3 |
| `page` | `#app > #app-view` | `render` on error / landing | 3 |
| `overlays` | `#overlay-root`, last child of `body` | `render` at boot; toast stack + modal outlet | 1 |
| dev panels | own lazy containers | `render` | 5 |

`#app` stays shared with the product iframe (`bridge.ts` / `@parity/truapi-host`).
Solid owns only child containers inside it. `activateHost` calls the stored root
disposers instead of pruning nodes or writing `innerHTML = ""`.

Iframe geometry writes (today in `bridge.ts`, `topbar-autohide.ts`,
`chat/panel.ts`, `truapi-debug/panel.ts`, `sandbox-checker-ui.ts`) are
consolidated into one `product-frame-layout.ts` driven by the topbar and chat
stores.

### Stays imperative

Product and protocol iframes, service workers and `pwa.ts`, the Blob URL
favicon, `postMessage` bridges, `wipeOriginState` / `applyAndReset`, the
sandbox `document.write` handoff. Inside components, via refs and effects: the
QR canvas (lazy `qrcode`, stale-payload guard), rAF typewriter and progress
crawl, the chains `slideStrip` layout read, focus traps, the chat
`IntersectionObserver`.

Promise APIs (`showPermissionRequestModal`, `showPreimageSubmitModal`,
`showPasswordPrompt`, UserConfirmation) push an entry into a modal store rendered
by `<ModalOutlet>`; abort removes the entry and settles as `dismissed`.
`blocking-modal-queue.ts` is unchanged. `showNotification` pushes into a toast
store rendered by `<ToastStack>`.

### Sandbox

`render` only, into `#overlay-root` and a page container added to
`apps/sandbox/index.html`. `document.write` still replaces the document; nothing
needs disposing.

### Prerender pipeline (sub-project 4)

A local Vite plugin, `packages/ui/src/mount/prerender-plugin.ts`, loads
`shell.server.tsx` with `ssrLoadModule` in `transformIndexHtml` and replaces
placeholders such as `<!--ssr:shell-->` with `renderToString(..., { renderId })`
output. The same path runs in `vite dev` and `vite build`; no extra Turbo task.
Theme stays on `<html data-theme>` from the inline bootstrap script, so
prerendered HTML is theme-neutral. `index.html` keeps its inline scripts (IDB
pre-open, theme bootstrap, petal spinner).

## Testing

- Unit tests (Vitest + happy-dom) are rewritten against public APIs. Components
  render through `@solidjs/testing-library`; assertions after an event or store
  write run after `flush()`. Static `document.body.innerHTML` fixtures are
  removed as areas stop depending on static markup. Existing semantic checks
  stay (the `error-page` XSS test, chains `data-block` node reuse).
- New: store tests; hydration tests per prerendered root (render to string,
  inject, `hydrate`, assert no mismatch warning and a working handler); a
  prerender-plugin test.
- Playwright selectors are a frozen contract: `.error-page-*`,
  `#error-retry-btn*` (host and sandbox frame), `#auth-button`, `.user-badge`,
  `#auth-modal-qr canvas`, `#user-popover-username`, `.signing-modal-backdrop`,
  the button names "Allow", "Always allow", "Sign", "Switch to Gateway", toast
  text, and the `dotli:truapi-auth-state` event. The functional suite runs in
  every sub-project PR; e2e runs before merging sub-projects 1, 3, and 4.

## Performance gates

Baselines are recorded on `main` in sub-project 0 (`docs/perf/solid-migration-baseline.md`).

| Metric | Gate |
|---|---|
| Host eager path gzip (entry `index-*.js` plus every chunk it statically imports / modulepreloads) | at most **+25 KB** gzip over the whole migration (amended 2026-09-26, owner decision; was +15 KB, which Solid's ~15.5 KB runtime alone reaches once the shell hydrates in sub-project 4); each sub-project other than 4 at most +2 KB net of deleted code |
| Sandbox eager path gzip (entry chunk plus every chunk it statically imports / modulepreloads) | at most +10 KB gzip over the whole migration; **no Solid at sandbox startup** (amended 2026-09-26) |
| Cold start `dotli:main:start` → `:end` (median of 10, `test:perf`) | no regression beyond 5% |
| First paint (sub-project 4) | topbar and loading screen present with JS disabled (Playwright) |

Known conflict (recorded 2026-09-25): Solid 2's runtime alone is about 15.5 KB gzip (minimal `render` + signals + `For`/`Show`, production build). Sub-project 4 puts it on the host startup path, which by itself reaches the +15 KB host limit. Sub-project 1 avoids it by loading overlays lazily; sub-project 4's spec decides the host limit with real measurements.

The bundle-size workflow stays warning-only; the gate is checked in the PR
description from its comment and a `test:perf:compare` run.

## Error handling

- Every root is wrapped in `<Errored>`. A failing root shows a fallback and
  reports to Sentry; other roots keep working. The `page` root falls back to
  the generic error page.
- A hydration mismatch fails the hydration tests. In production a root that
  fails to hydrate clears its container, remounts with `render()`, and logs a
  Sentry breadcrumb.

## Sub-projects

| # | Name | Contents |
|---|---|---|
| 0 | Foundation | Pinned deps, JSX tooling, stores fed by current producers, overlay-mount and test helpers, baselines, delete `alias-permission-modal.ts`. No user-visible change. Spec: `2026-09-25-solid-v2-sp0-foundation-design.md` |
| 1 | Modals and toasts | `permission-modal`, `preimage-modal`, `password-prompt`, `UserConfirmation`, `notification` → components in the `overlays` root, loaded lazily (no Solid on either startup path). Spec: `2026-09-25-solid-v2-sp1-overlays-design.md` |
| 2 | Chat | `chat/panel`, `custom-renderer`, `custom-message`; chat shell markup leaves `index.html`. Lazy chat chunk; custom renderer reused unchanged. Spec: `2026-09-25-solid-v2-sp2-chat-design.md` |
| 3 | Pages in `#app` | landing page (on the host startup path, after sub-project 4 puts Solid there) and `activateHost` switching to root disposers. Error pages and the sandbox error / retry screen stay imperative (amended 2026-09-26). Runs **after** sub-project 4 |
| 4 | Shell + prerender | topbar split into components (auth/QR, user, theme, more, permissions, network, settings/diagnostics), autohide, verification shield, URL pill, offline banner, `product-frame-layout.ts`, prerender plugin and hydration; unify the `dotli:permission-changed` detail to `{ label, permission }` for both producers (today `PromptPermission` sends `{ label }` and the topbar permissions popover sends `{ label, permission }`) |
| 5 | Dev tools | truapi-debug panel (resolution view, timeline), sandbox-checker panel |

Order (amended 2026-09-26): 0 → 1 → 2 → 5 → 4 → 3. Sub-project 4 comes before 3 because the landing page is first paint and needs Solid on the host startup path, which sub-project 4 introduces.

## Risks

- **RC churn.** API changes between RC builds. Mitigation: exact pins,
  deliberate bumps, the `solid-migration-assistant` / changelog check on each
  bump.
- **Hydration mismatch** from browser-only reads during the first render.
  Mitigation: fixed store defaults, post-hydrate writes, hydration tests,
  production remount fallback.
- **Batched updates** breaking sync write-then-read code. Mitigation: stores
  are plain values with synchronous getters; only components hold signals.
- **Cold-start cost** of the runtime on the eager path. Mitigation: the gates
  above, measured from sub-project 0.
