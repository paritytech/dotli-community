# AGENTS.md

## Project

dotli is a decentralized web browser that runs inside a normal browser. It opens Polkadot apps by `.dot` name with no
server in the trust path.

It is a reference implementation and a prototype. It is not a wallet, runs no backends and pins no content. Keep it
trustless, small on boot and fast on repeat visits.

## Glossary

- **Host**: the top-level shell build. Owns the topbar, session and bridge.
- **Sandbox / app context**: the per-product origin that loads and renders a product's files.
- **Product**: a dApp published under a `.dot` name. Also called "the app".
- **dotNS**: the naming contracts. Registry plus ContentResolver map a name to a contenthash.
- **Bulletin Chain**: the chain that stores product content.
- **smoldot**: the in-browser light client.
- **TrUAPI**: the host to product protocol (accounts, signing, chain connections, scoped storage, chat). Rust core from
  `@parity/truapi`.
- **Polkadot App**: the mobile signer the user pairs with by QR to log in and sign.
- **Manifest**: the product's executable manifest (`worker.<label>.<tld>`). Declares features such as `includes.chat`.
- **Debug panel**: the TrUAPI inspector.

Workflow thresholds (trivial, blast radius, peer file) live in `docs/code/glossary.md`.

## Architecture

- Split the system into layers. Each owns one responsibility that a reader can name from its module.
- Keep the interface between layers small, explicit and easy to read.
- State flows up, intent flows down. Never write another layer's state, and never use state as a command.
- A layer recovers from its own failures without waiting to be asked, and reports its status to the layer above.
- Make calls across layers idempotent. Repeating or overlapping a call is safe and does the work once.
- Depend on what you import, not on global channels. Use global events only at real system boundaries.
- Agree on the layers, their interfaces and their failure paths before writing code that crosses them.
- Simple unit tests are the check of a good split. A test that needs module mocks or global overrides points at a
  missing seam.

Tools:

- Use `createAsyncTaskPool` from `@dotli/shared` to resolve internal races, to retry, and to run several flows at once.
  Don't hand-roll queues, in-flight flags, retry timers or concurrency limits.

## Packages

What a package owns and exposes is in its `README.md`. What it may import is in its `eslint.config.js`. The host is the
top layer and may import every package, so its config lists none.

- A view, screen or flow used by one app lives in that app. The host's domain building blocks (account, chat,
  permission, settings and chain views, and their icons) sit in its `src/components/<domain>/` beside the flows that
  compose them.
- Primitives, icons, the brand marks, the tokens, and the screens and overlays both apps show live in `@dotli/ui`. Its
  entries are the index, `./icons`, `./brand`, `./styles.css` and `./testing`.
- A component that owns an interaction with the product (a subscription, an action and its error copy) is a flow. A
  building block takes props, reads no store and reports the user's intent through a callback.
- Import a component where it is used and let the bundler split chunks. What a visit may never open (a panel's content,
  the debug panel) loads through `lazy()` or a loader in `src/lazy.ts`. The startup size budgets in CI guard what a page
  loads first, not import rules.
- The host's side of TrUAPI and the session lives in the host app, in `src/runtime/`.
- The debug panel is its own lazily loaded package with its own UI kit. It reads the host through its port and the debug
  bus.

## Code style

General:

- Don't disable rules without a one-line reason.
- Prefer the framework's own mechanism (Astro, Solid 2, Vite) over hand-written machinery.
- Fix races and duplicate resources structurally (one refcounted owner), not with flags or delays.

Packages:

- Each package exposes only `src/index.ts`. Never import another package's internal modules.
- Relative imports use `.js` extensions. `.ts` only in files Node loads directly.
- On-demand modules go through a loader in `src/lazy.ts` to stay a separate chunk.
- Declare `sideEffects` in every `package.json`.

TypeScript:

- Never swallow errors. Rethrow with `{ cause }`, or `captureException` + `log.error` + an outcome metric.
- One metric name per event, with `{ outcome, reason }`. No `_FAILURE` / `_TIMEOUT` constants.
- `log.warn` only for real failures. Progress breadcrumbs use `log.event`.
- No `console.log`.

UI:

- Astro for static markup. Solid islands only for interactive controls, one module per island.
- Keep the sync stores (`createSyncStore`) for app state. Don't swap them for Solid stores.
- Styles in a CSS module beside the component.
- Colors only from tokens in `packages/ui/src/global.css`. dotli chrome is dark only.
- Every icon is a Solid component with an `<svg>` inside, drawn in `currentColor`, with a `size` prop when it needs
  resizing. Never markup in a string or built from DOM calls.
- A module styles only its own elements. Page state through `:global([data-…])`.
- State that logic or tests read is a `data-*` attribute, not a class.

Comments and docs:

- Comments say why or what constraint applies. Never restate the code.
- JSDoc starts with one sentence. Files may open with a short purpose block.
- No em-dashes, semicolons or Unicode arrows in prose. No decorative separators. No spec citations in comments.
- Say "network" or "remote", not "on-chain".
- Every package has a `README.md` in its root: its responsibility, basic design and public API (each `exports` entry),
  or entry points for an app. It explains the package at a high level and names no files and no other packages. Diagrams
  are mermaid, not ASCII. A change to any of these updates the README in the same commit.

Tests:

- A unit test sits beside its module: `src/foo.ts` gets `src/foo.spec.ts`. It runs under Node.
- A unit test needs no DOM mocking (no happy-dom, no `document` or `window`, no DOM polyfills, no testing-library). It
  tests business logic. A test that needs a DOM tests an integration layer, so give the logic a seam.
- A component is tested by a play function in its Storybook story, which runs in a real browser.
- Functional tests may mock the DOM. They live in `<pkg>/tests/` as `*.test.ts` and run under happy-dom.
- Test-only modules live in `src`: `<name>.fake.ts` beside the module it fakes, shared fixtures in `src/testing/`. Never
  export them from `src/index.ts`. Another package reaches them through a `./testing` package entry.
- A shared fixture that reads the page is named `<name>.dom.ts`. Only functional tests and stories use it.
- There is one Storybook, at the repo root. It runs every story in every app and package. Story fixtures and frames live
  in the package's `src/testing/stories/` and are never exported. Stories may also import `./testing` entries.
- Helpers every package's tests use live once: in `@dotli/shared/testing`, the page wait `untilDom` included, and page
  queries in `@dotli/ui/testing`.
- Name tests as user stories: `As a <role>, I <action> and <outcome>`.
- Separate bodies with `// Given`, `// When`, `// Then`.
- Select by `data-testid` or ARIA role. Never by class.
- Never test CSS (stylesheets, computed styles, class names).
- Wait on signals, never sleep.
- Pass fakes through parameters. Don't mock modules, and avoid overriding globals. Shape the code so tests drive it
  through its interface.

Git:

- PR descriptions: cause and fix in a few sentences, details are optional and can be added if the solution is complex.
