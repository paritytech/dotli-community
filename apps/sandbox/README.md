# `@dotli/sandbox`

The per-product origin that loads and renders a product's files. It runs inside the host's iframe and does no name
resolution. See the root [README](../../README.md) for the product as a whole.

## Responsibility

- Read the host's URL contract, fetch and verify the product's content by CID, and write its page into the window.
- Serve the product's files to its page through a service worker.
- Ask for a password when content is encrypted, and show a retry screen when a load fails.
- Not name resolution or the chain connection: the host and the protocol app do that. Block requests go to the host,
  which proxies them to the protocol iframe.

## Design

- Boot starts Sentry and listens for chunk preload errors before anything else.
- A runner performs the load once, and again on each retry the visitor asks for, up to a limit. Every failure is
  reported and shown. It refuses to run as a top-level page.
- One load fetches and verifies the content, hands an archive to the service worker and writes the page. It never
  throws, so the caller learns which step failed.
- Blocks come from the host parent through a bridge. Progress and completion go back to the host the same way.
- The service worker serves the archive, injects the sandbox checker and keeps the archive in IndexedDB for restarts.
  The page side registers it and checks its version. The packed archive reaches the controlling worker by a handoff.
- After a load the origin's stores are purged of anything the product left behind.
- Boot never imports the password dialog, the retry screen's view or any entity view. A lazy loader brings them in on
  demand. Boot takes UI only from the UI core, which imports no Solid, and the icons entry. Its dialogs are `ModalView`
  data, with an icon component, that the shared dialog renders.
- The error page and the retry screen take the page over at once and show their Solid view once its chunk arrives. The
  retry screen's view is the sandbox's one Solid component and draws the brand's petal mark. When a chunk cannot load,
  the screen shows its words as text alone, with no icon or mark.
- A small helper for product sub-pages is a real module that the service worker inlines as a classic script. The service
  worker is built as a separate bundle after the page.

```mermaid
flowchart LR
  host[host iframe] -- URL contract --> runner --> load
  load --> fetch["content fetch, blocks via the host"]
  load --> handoff[archive handoff] --> sw[app service worker] --> page[product page]
```

## Entry points

- The sandbox page. Dev server on port 4322.
- The service worker, built as its own bundle.
- `npm run dev`, `build`, `build:prod`, `typecheck`, `lint`, `test`.
- `npm run storybook`, `build-storybook`, `test:stories`, `test:vrt`.
