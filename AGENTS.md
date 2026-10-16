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

## Architecture

- Split the system into layers. Each owns one responsibility that a reader can name from its module.
- Keep the interface between layers small, explicit and easy to read.
- State flows up, intent flows down. Never write another layer's state, and never use state as a command.
- A layer recovers from its own failures without waiting to be asked, and reports its status to the layer above.
- Make calls across layers idempotent. Repeating or overlapping a call is safe and does the work once.
- Depend on what you import, not on global channels. Use global events only at real system boundaries.
- Agree on the layers, their interfaces and their failure paths before writing code that crosses them.

Tools:

- Use `createAsyncTaskPool` from `@dotli/shared` to resolve internal races, to retry, and to run several flows at once.
  Don't hand-roll queues, in-flight flags, retry timers or concurrency limits.

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
- Keep the Solid-free sync stores. Don't swap them for Solid stores on the boot path.
- Styles in a CSS module beside the component.
- Colors only from tokens in `packages/ui/src/global.css`. dotli chrome is dark only.
- A module styles only its own elements. Page state through `:global([data-…])`.
- State that logic or tests read is a `data-*` attribute, not a class.

Comments and docs:

- Comments say why or what constraint applies. Never restate the code.
- JSDoc starts with one sentence. Files may open with a short purpose block.
- No em-dashes, semicolons or Unicode arrows in prose. No decorative separators. No spec citations in comments.
- Say "network" or "remote", not "on-chain".

Tests:

- Name tests as user stories: `As a <role>, I <action> and <outcome>`.
- Separate bodies with `// Given`, `// When`, `// Then`.
- Select by `data-testid` or ARIA role. Never by class.
- Never test CSS (stylesheets, computed styles, class names).
- Wait on signals, never sleep.
- Don't mock modules. Shape the code so tests drive it through its interface or inject what it depends on.

Git:

- PR descriptions: cause and fix in a few sentences, details are optional and can be added if the solution is complex.
