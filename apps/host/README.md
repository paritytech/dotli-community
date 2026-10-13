# `@dotli/host`

The top-level shell of dotli, built with Astro. It owns the topbar, the session and the bridge, and it opens a product
by `.dot` name inside a sandbox iframe. See the root [README](../../README.md) for the product as a whole.

## Responsibility

- Route a page load to a product, a local or preview target, or the landing page.
- Take a `.dot` label to a product on screen, or to the screen that says why not.
- Own the page chrome: topbar, URL pill, loading screen, chat dock, settings, account, permissions and network views.
- Own the page state only the host reads: the network monitor behind the network panel (block bars, phases, peers,
  transfer and the health verdict) and the landing page's recently visited names.
- Start the protocol iframe, the TrUAPI bridge and the auth controller, and build the ports the runtime needs.
- Not the bridge, session or auth logic itself, which the host runtime owns. Not content rendering, which the sandbox
  does.

## Design

- Two Astro pages, the shell and the landing page. Each has its own entry. Both start Sentry before any other module
  runs, then call one page start (the chunk and island failure offers and the desktop offer) and share one startup step:
  settings, the protocol iframe, the bridge and auth.
- Static markup is Astro. Interactive controls are Solid islands, one module per island, bound to sync stores that
  import no Solid.
- The toasts and dialogs are one idle island on each page. What boot queues before it hydrates shows once it does.
- Components are imported where they are used. The startup size budgets in CI guard what each page loads first.
- Views and rarely used modules load on demand through a lazy loader, each in its own chunk: bridge ports, load-failure
  screens, cache revalidation, product branding, chat, account, chains, permissions, settings, verification, the
  violation panel, the debug panel and the workbox.
- The error page and the no-content page replace the page's content at once, through the shared screen owner. A
  full-page screen ends the loading screen and the landing islands, and the product frame takes the screen down when it
  shows.
- Flows take their data sources and screens as parameters, so they run under Node without mocks. Two binders connect the
  runtime's `BridgePorts` to the page's dialogs, notifications, frame layout and network monitor.
- The network monitor opens no chain. The bridge reports who holds each host chain and its best blocks to it through the
  `chainActivity` port, and the load progress reports phases, peers and transfer.
- The recently visited names live in the store every subdomain shares, reached through the runtime's shared channel,
  with a per-origin mirror for when that store is unreachable.
- Whether a product declares chat is read from its worker manifest alongside its name and travels on the product the
  frame renders. The last answer is cached per label, so a warm load picks the connection's execution kind without
  waiting on a dotNS read.
- An island that must stand in for itself when it breaks (the landing page, the sign-in modal, the loading screen) wraps
  its tree in its own error boundary. An island whose code fails to load once page start has run is reported and offers
  a reload, the same offer as a page chunk that fails. One that fails before then, such as an island that loads with the
  page, reaches the console alone.
- The Astro config adds the PWA service worker, the signing worker, the dev SPA fallback and a Sentry release upload,
  all from the shared Vite tooling.

```mermaid
flowchart LR
  url[URL] --> route --> loader[product loader]
  loader --> resolve["protocol iframe: resolve"] --> render["sandbox iframe: render"]
  loader --> checks["manifest gate, block verifier, load-failure screens"]
  startup --> bridge["runtime bridge and auth"]
  ports["bridge ports: dialogs, frame view, chain activity"] --> bridge
```

## Entry points

- The shell page. Dev server on port 4321.
- The landing page, served for the bare host.
- `npm run dev`, `build`, `build:prod`, `typecheck`, `lint`.
- `npm test`: unit specs. `test:functional`, `test:e2e`, `test:e2e:local` and `test:perf*` run Playwright suites. A
  local functional run needs `VITE_METRICS=true` in both the build and the run.
- `npm run storybook`, `build-storybook`, `test:stories`, `test:vrt`: component stories and their visual checks.
