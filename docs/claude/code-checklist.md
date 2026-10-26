# Reviewer: code checklist

Walk this for every file the diff touches. Cite the doc and section when flagging. Severity:

- **blocking**: breaks an `## Architecture` rule in `AGENTS.md`, or puts a server in the trust path (`## Project`).
- **major**: breaks any other documented rule. Rows from the `Tools:` label under `## Architecture` are major.
- **minor**: comment, prose, naming and the order inside a file.

Severity only orders the work. Every finding is fixed in this branch.

This checklist lists only rules ESLint does not enforce. `config/eslint/vite.js` catches `console`, an empty `catch`, an
`Error` built by concatenating `err.message`, exported `_FAILURE`, `_TIMEOUT` and `_RETRY` constants, `.ts` import
paths, type imports, the strict type and promise rules, test-only imports in shipped code, and DOM tooling and globals
in unit specs. The typecheck catches dot access to CSS module classes. Don't re-raise them. The reviewer is the layer
above the linter: semantics, data flow and naming.

## Compatibility

- **major** (AGENTS.md § Project): A runtime API newer than the browser floor in shipped code.

## Code shape

- **major** (docs/code/style.md § A factory returns a plain object): A class for a stateful unit, other than an `Error`
  subclass, a data structure, or a measured hot path kept private behind a factory.
- **major** (docs/code/style.md § The public type comes from the implementation): A hand-written type that restates a
  factory's return or a schema's shape, where the contract has one implementation.
- **major** (docs/code/style.md § A module exports one named object per entity): A module that owns an entity and
  exports its actions loose instead of in one object named after the entity.
- **major** (docs/code/style.md § Declarations at the top, arrows inline): A top-level function or a named step inside a
  factory written as an arrow const.
- **major** (docs/code/style.md § Params object for factories, two positional inputs at most): A factory of a stateful
  unit with positional params, or any function with more than two positional inputs.
- **major** (docs/code/style.md § One job per function): A block inside a function that needs a comment to say what it
  does, instead of a named function.
- **major** (docs/code/style.md § Dependencies come in through parameters): A unit that imports a network client,
  storage, a timer, the clock or a randomness source instead of taking it through its params.
- **major** (docs/code/style.md § Inject through a framework only where the architecture defines it): A registry that
  modules fill as a side effect of being imported, or injection along a path the architecture does not define.
- **major** (docs/code/style.md § Wrap to add behaviour): A cross-cutting concern (cache, retry, dedupe, replay) built
  into a core function instead of wrapped around it.
- **major** (docs/code/style.md § Share knowledge, not look-alike code): A shared function that takes a flag or branch
  per caller, or a domain rule shared across its boundary.
- **major** (docs/code/style.md § Name repeated control flow as a combinator): The same control-flow pattern written
  inline in two places instead of a named combinator.
- **major** (docs/code/style.md § Derive, don't store): A stored value kept in sync with state it can be computed from.
- **major** (docs/code/style.md § Private writable, public read-only): A module that exposes writable state, or writes
  state another module owns.
- **major** (docs/code/style.md § Mutate inside, stay immutable outside): A function that mutates its input or shared
  state, other than an in-place algorithm named for it with a `CAUTION` JSDoc.
- **major** (docs/code/style.md § Every subscription returns its cleanup): A `subscribe` without an unsubscribe, or a
  unit holding a connection, timer or listener without `dispose()`.
- **major** (docs/code/style.md § Guard first, then the happy path): Nested conditions where early returns would keep
  the main logic unindented.
- **major** (docs/code/style.md § `for...of` over `forEach` and `for...in`): A `forEach` with a callback, or `for...in`.
- **major** (docs/code/style.md § Branch on a union in its own function): A union mapped by a ternary chain or an `if`
  ladder inline, or a `switch` over a closed union with a `default`.
- **major** (docs/code/style.md § Brand values that look alike): An identifier or encoded value passed as a bare
  `string` or `Uint8Array` where another kind could be passed in its place.
- **major** (docs/code/style.md § Parse at the boundary): Data from the network, storage or another context used without
  a schema parse where it enters, or defensive checks on data already parsed.
- **major** (docs/code/style.md § Every cross-boundary message has a versioned format): A message across a frame, a
  worker or the network without a versioned schema or codec, built by hand by the sender, or a receiver that guesses at
  an unknown version.
- **major** (docs/code/style.md § Strict everywhere, escape hatches only in library code): `as`, `as never`,
  `as unknown as X` or `@ts-expect-error` in application code, one in library code without a one-line reason, or an
  exported function without a return type other than a factory whose type is derived from it.
- **major** (docs/code/style.md § Throw errors, catch at the boundary): A result wrapper inside a layer, a catch that
  adds context without `{ cause }`, or failures told apart by their message instead of `instanceof`.
- **major** (docs/code/style.md § Thread an `AbortSignal`): An async API that waits on the network, a timer or another
  context and takes no optional `signal`.
- **major** (docs/code/style.md § Serial when order matters): Independent steps awaited one after another, or steps run
  in parallel where one reads what another writes.
- **major** (docs/code/style.md § One concept per file, named after its export): A file with more than one factory or
  concept, or a file not named after its main export in camelCase.
- **major** (docs/code/style.md § Named exports and one explicit barrel): A default export, `export *`, a nested barrel,
  or type and value exports on one line.
- **major** (docs/code/style.md § Tests): Three or more inputs of one behaviour as separate tests instead of `it.each`,
  an event stream asserted event by event, or a cache hit asserted with `toEqual`.
- **minor** (docs/code/style.md § Main export before its helpers): Private helpers above the main export.
- **minor** (docs/code/style.md § Function names start with a verb): A function name that starts with no verb, or a
  factory, predicate, wrapper or escape hatch without its `createX`, `isX`, `hasX`, `withX` or `unsafe_` form.
- **minor** (docs/code/style.md § Generic names are words): A type parameter named by a letter where it is not the one
  obvious parameter, or a type extractor not named `InferX`.
- **minor** (docs/code/style.md § Naming): An abbreviation other than a single-letter callback parameter, a type not
  named for its role, or a module-level primitive or static table not in SCREAMING_CASE.
- **minor** (docs/code/style.md § Messages name the value and the place): An error message without the failing value or
  the place it failed.
- **minor** (docs/code/style.md § Comments): An exported library function without a one-sentence JSDoc and a usage
  example.

## Errors and logging

- **major** (AGENTS.md § Code style, TypeScript:): A `catch` that drops the error, with neither a rethrow with
  `{ cause }` nor `captureException`, `log.error` and an outcome metric.
- **major** (AGENTS.md § Code style, TypeScript:): `log.warn` for progress or status. It is for real failures, and
  progress breadcrumbs use `log.event`.
- **major** (AGENTS.md § Code style, TypeScript:): A free-standing wrapper that makes a dependency safe to call, where
  the object the page builds should carry the guarantee.

## Metrics

- **major** (AGENTS.md § Code style, TypeScript:): More than one metric name for one event, or an outcome metric without
  `{ outcome, reason }`.

## Async and lifecycle

- **major** (AGENTS.md § Code style, General:): A race between duplicate resources patched with a flag, a deferral or a
  delay instead of one refcounted owner.
- **major** (AGENTS.md § Architecture, Tools:): In-flight work deduped with a promise flag or a join-by-key option
  instead of a named pool of size 1 and an idempotent task.

## UI and styles

- **major** (AGENTS.md § Code style, General:): Hand-written machinery where Astro, Solid 2 or Vite has its own
  mechanism, or parts of an old mechanism kept beside the framework's after a migration.
- **major** (AGENTS.md § Code style, General:): JavaScript shipped as a string, such as a serialised function or an
  inline script block.
- **major** (AGENTS.md § Code style, UI:): A Solid island for static markup, or more than one island in a module.
- **major** (AGENTS.md § Code style, UI:): App state moved off `createSyncStore` to Solid signals or stores.
- **major** (AGENTS.md § Code style, UI:): An icon that is not a Solid component with an `<svg>` drawn in
  `currentColor`, such as markup in a string, a path-data constant, `innerHTML` or DOM calls.
- **major** (AGENTS.md § Code style, UI:): A color not taken from the tokens in `packages/ui/src/global.css`, or a light
  theme, light palette or theme toggle for dotli chrome.
- **major** (AGENTS.md § Code style, UI:): A module that styles elements it does not own, or reads page state other than
  through `:global([data-…])`.
- **major** (AGENTS.md § Code style, UI:): State that logic or tests read kept in a class instead of a `data-*`
  attribute.
- **major** (AGENTS.md § Code style, UI:): A generated type file for CSS modules, a script that generates one, or a
  relaxed `noPropertyAccessFromIndexSignature`.
- **major** (AGENTS.md § Code style, UI:): CSS scoped with an exclusion such as `:not([data-x])` instead of a positive
  `data-*` attribute on the target.
- **major** (AGENTS.md § Code style, UI:): Spacing in px where a `--sp-*` token applies.
- **major** (AGENTS.md § Code style, UI:): A token, color or spacing value changed without the task asking for it,
  including to fix contrast.
- **major** (AGENTS.md § Code style, UI:): A new variant, prop, padding or size on a common component to match one
  screen.
- **major** (AGENTS.md § Code style, UI:): Ratio math, a new component or a new asset variant to match a design.
- **major** (AGENTS.md § Code style, UI:): An icon or logo inside a decorative tile or tinted shape.

## Comments and prose

- **major** (AGENTS.md § Code style, General:): A disabled lint rule without a one-line reason.
- **minor** (AGENTS.md § Code style, Comments and docs:): A comment that restates the code instead of saying why or what
  constraint applies.
- **minor** (AGENTS.md § Code style, Comments and docs:): A JSDoc block that does not start with one sentence.
- **minor** (AGENTS.md § Code style, Comments and docs:): An em-dash, semicolon or Unicode arrow in prose, a decorative
  separator, or a spec citation in a comment.
- **minor** (AGENTS.md § Code style, Comments and docs:): "On-chain" where "network" or "remote" fits.
- **minor** (AGENTS.md § Code style, Comments and docs:): A comment that claims a relation to other code.
- **minor** (AGENTS.md § Code style, Comments and docs:): An interface method whose JSDoc does not state its contract,
  such as whether and with what it rejects.
- **minor** (AGENTS.md § Code style, Comments and docs:): "Solid-free" instead of "imports no Solid".
- **minor** (AGENTS.md § Code style, Comments and docs:): An example in a doc or rule that names a specific file,
  component or past incident instead of a general shape.
- **minor** (AGENTS.md § Code style, Comments and docs:): A package `README.md` that names files or other packages, or
  draws an ASCII diagram instead of mermaid.

## Tests

- **major** (docs/code/placement.md § Inside a package): A unit test that does not sit beside its module as
  `src/foo.spec.ts`, or a DOM-mocked test outside `<pkg>/tests/`.
- **major** (AGENTS.md § Code style, Tests:): A component's behaviour tested anywhere but a play function in its
  Storybook story.
- **major** (AGENTS.md § Code style, Tests:): A module mock or a global override where a fake passed through a parameter
  would do.
- **major** (AGENTS.md § Code style, Tests:): An element selected by class instead of `data-testid` or ARIA role.
- **major** (AGENTS.md § Code style, Tests:): A test of CSS: stylesheets, computed styles, class names or the
  CSS-modules config.
- **major** (AGENTS.md § Code style, Tests:): A sleep, `waitForTimeout` or other fixed delay instead of waiting on a
  signal.
- **major** (AGENTS.md § Code style, Tests:): A committed test that exercises a third-party SDK's own setup.
- **minor** (AGENTS.md § Code style, Tests:): A test not named as a user story, `As a <role>, I <action> and <outcome>`,
  the role with an optional `who …` clause.
- **minor** (AGENTS.md § Code style, Tests:): A test body without `// Given`, `// When` and `// Then`, or descriptive
  markers cut to bare ones.
- **minor** (AGENTS.md § Code style, Tests:): A test whose call under test sits outside `// When`, or whose `// Then`
  does more than assert.

When you cite a rule, quote `file:line`, state it in one line with its doc and section, and suggest the fix in one or
two sentences. Group findings by theme and end with the blocking, major and minor counts.
