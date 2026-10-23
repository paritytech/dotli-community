# Reviewer: code checklist

Walk this for every file the diff touches. Cite the doc and section when flagging. Severity:

- **blocking**: breaks an `## Architecture` rule in `AGENTS.md`, or puts a server in the trust path (`## Project`).
- **major**: breaks any other documented rule. Rows from the `Tools:` label under `## Architecture` are major.
- **minor**: comment, prose and naming.

Severity only orders the work. Every finding is fixed in this branch.

This checklist lists only rules ESLint does not enforce. `config/eslint/vite.js` catches `console`, an empty `catch`, an
`Error` built by concatenating `err.message`, exported `_FAILURE`, `_TIMEOUT` and `_RETRY` constants, `.ts` import
paths, type imports, the strict type and promise rules, test-only imports in shipped code, and DOM tooling and globals
in unit specs. The typecheck catches dot access to CSS module classes. Don't re-raise them. The reviewer is the layer
above the linter: semantics, data flow and naming.

## Errors and logging

- **major** (AGENTS.md § Code style, TypeScript:): A `catch` that drops the error, with neither a rethrow with
  `{ cause }` nor `captureException`, `log.error` and an outcome metric.
- **major** (AGENTS.md § Code style, TypeScript:): `log.warn` for progress or status. It is for real failures, and
  progress breadcrumbs use `log.event`.

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
- **minor** (AGENTS.md § Code style, Tests:): A test not named as a user story, `As a <role>, I <action> and <outcome>`.
- **minor** (AGENTS.md § Code style, Tests:): A test body without `// Given`, `// When` and `// Then`, or descriptive
  markers cut to bare ones.

When you cite a rule, quote `file:line`, state it in one line with its doc and section, and suggest the fix in one or
two sentences. Group findings by theme and end with the blocking, major and minor counts.
