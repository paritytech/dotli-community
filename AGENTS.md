# AGENTS.md

## Project

dotli is a decentralized web browser that runs inside a normal browser. It opens Polkadot apps by `.dot` name with no
server in the trust path.

It is a reference implementation and a prototype. It is not a wallet, runs no backends and pins no content. Keep it
trustless, small on boot and fast on repeat visits.

A debug-only feature, such as signing in with a recovery phrase, appears only in the debug panel, never in user-facing
UI.

The browser floor is ES2022 and Safari 17.4. Shipped code uses no runtime API newer than that.

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
- A page that shares an origin with another layer's stores removes only its own keys and databases. It never clears the
  origin and writes the other layer's state back.
- A layer recovers from its own failures without waiting to be asked, and reports its status to the layer above.
- Make calls across layers idempotent. Repeating or overlapping a call is safe and does the work once.
- When a reopened subscription replays items its source still holds, the consumer dedupes them. Layers in between pass
  them through and never dedupe.
- Depend on what you import, not on global channels. Use global events only at real system boundaries.
- Agree on the layers, their interfaces and their failure paths before writing code that crosses them.
- Simple unit tests are the check of a good split. A test that needs module mocks or global overrides points at a
  missing seam.

Tools:

- Use `createAsyncTaskPool` from `@dotli/shared` to resolve internal races, to retry, and to run several flows at once.
  Don't hand-roll queues, in-flight flags, retry timers or concurrency limits.
- Dedupe in-flight work with a named pool of size 1 and an idempotent task, so a repeated call finds the work done.
  Don't add join-by-key to the pool.

## Packages

What each package owns and what it may import are in each package's `README.md` and `eslint.config.js`, summarised with
the placement rules in `docs/code/placement.md`.

## Code style

General:

- Don't disable rules without a one-line reason.
- Prefer the framework's own mechanism (Astro, Solid 2, Vite) over hand-written machinery.
- Fix races and duplicate resources structurally (one refcounted owner), not with flags or delays.
- Build dotli as a plain website that loads fast. Special build, startup or packaging machinery belongs only where a
  plain website can't cover the need: the sandbox, product isolation, iframe messaging and chain connections.
- Never ship JavaScript as a string, such as a serialised function or an inline script block. Every script is a real
  TypeScript module that the framework or a build plugin emits.
- Add a `package.json` `overrides` entry only when a clean resolve without it is vulnerable or broken. Give the reason
  in the commit or PR.

Packages:

- Relative imports use `.js` extensions. `.ts` only in files Node loads directly.
- Declare `sideEffects` in every `package.json`.

TypeScript:

- Never swallow errors. Rethrow with `{ cause }`, or `captureException` + `log.error` + an outcome metric.
- One metric name per event, with `{ outcome, reason }`. No `_FAILURE` / `_TIMEOUT` constants.
- `log.warn` only for real failures. Progress breadcrumbs use `log.event`.
- A guarantee such as never rejecting belongs to the object the page builds, not to a free-standing wrapper every caller
  must remember.
- No `console.log`.

UI:

- Astro for static markup. Solid islands only for interactive controls, one module per island.
- Keep the sync stores (`createSyncStore`) for app state. Don't swap them for Solid stores.
- Colors only from tokens in `packages/ui/src/global.css`. dotli chrome is dark only.
- Every icon is a Solid component with an `<svg>` inside, drawn in `currentColor`, with a `size` prop when it needs
  resizing. Never markup in a string or built from DOM calls.
- A module styles only its own elements. Page state through `:global([data-…])`.
- State that logic or tests read is a `data-*` attribute, not a class.
- Read CSS module classes as `s['foo']`. Never generate type files for CSS modules or relax
  `noPropertyAccessFromIndexSignature`.
- Select a CSS target by its own `data-*` attribute, never by excluding others with `:not(...)`.
- Spacing (`gap`, `padding`, `margin`) uses the `--sp-*` tokens. A value between two tokens rounds down, except in a
  phone override, which rounds up. Sizes and positions stay px. Equal values in one component stay equal. The debug
  panel has its own tokens.
- Never change a token, color or spacing value unasked, not even to fix contrast. Report it instead.
- Common components (sheets, modals, buttons, cards) keep their standard look. No new variants, props, paddings or sizes
  to match one screen. Where a design differs, the standard component wins.
- To match a design, use plain values that are close enough. No ratio math, new components or new asset variants, and no
  unasked changes elsewhere.
- Icons and logos stand bare on the surface, never in a decorative tile or tinted shape. A functional frame, such as a
  QR code's quiet zone, is fine.

Comments and docs:

- Comments say why or what constraint applies. Never restate the code.
- JSDoc starts with one sentence. Files may open with a short purpose block.
- No em-dashes, semicolons or Unicode arrows in prose. No decorative separators. No spec citations in comments.
- Say "network" or "remote", not "on-chain".
- Every interface method's JSDoc states its contract, such as whether and with what it rejects.
- Comments never claim a relation to other code, which can change without touching the comment. When two values must
  stay in sync, share a token, variable or import, or write nothing.
- Say "imports no Solid", never "Solid-free".
- Examples in docs and rules are general shapes a reader can map onto their own case ("a component's CSS module", "a
  multi-step modal"), never a specific file, component or past incident.
- Every package has a `README.md` in its root: its responsibility, basic design and public API (each `exports` entry),
  or entry points for an app. It explains the package at a high level and names no files and no other packages. Diagrams
  are mermaid, not ASCII. A change to any of these updates the README in the same commit.

Tests:

- A unit test runs under Node.
- A unit test needs no DOM mocking (no happy-dom, no `document` or `window`, no DOM polyfills, no testing-library). It
  tests business logic. A test that needs a DOM tests an integration layer, so give the logic a seam.
- A component is tested by a play function in its Storybook story, which runs in a real browser.
- Functional tests may mock the DOM and run under happy-dom.
- Name tests as user stories: `As a <role>, I <action> and <outcome>`, where the role may carry a `who …` clause.
- Separate bodies with `// Given`, `// When`, `// Then`.
- The call under test sits in When, and Then only asserts.
- Given/When/Then markers keep their descriptions. A comment cleanup never strips them to bare markers.
- Don't commit tests that exercise a third-party SDK's own setup. Check that configuration once, by hand.
- Select by `data-testid` or ARIA role. Never by class.
- Never test CSS (stylesheets, computed styles, class names).
- Wait on signals, never sleep.
- Pass fakes through parameters. Don't mock modules, and avoid overriding globals. Shape the code so tests drive it
  through its interface.

Git:

- PR descriptions: cause and fix in a few sentences, details are optional and can be added if the solution is complex.
- Before pushing, run `npm run format:check` and `npm run knip` beside tests, lint and typecheck. ESLint covers neither
  formatting nor unused exports.
