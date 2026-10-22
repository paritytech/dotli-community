# Reviewer: architecture checklist

Walk this for any change that touches placement, layering, a package's structure or a public surface. Cite the doc and
section when flagging. Severity:

- **blocking**: breaks an `## Architecture` rule in `AGENTS.md`, or puts a server in the trust path (`## Project`).
- **major**: breaks any other documented rule. Rows from the `Tools:` label under `## Architecture` are major.
- **minor**: comment, prose and naming.

Severity only orders the work. Every finding is fixed in this branch.

This file is the citable index. The rules and their reasons live in the docs each row cites. It lists only rules ESLint
does not enforce. The imports each package may make are in its `eslint.config.js`, and `config/eslint/vite.js` refuses
`.ts` import paths, test-only modules and `./testing` entries in shipped code, and DOM tooling and globals in unit
specs. ESLint and CI catch those, so don't re-check them. If a violation is not covered here but breaks a documented
rule, flag it and propose a row.

## Layering

- **blocking** (AGENTS.md § Architecture): A module writes another layer's state, or a layer reads state as a command
  instead of taking intent from above.
- **blocking** (AGENTS.md § Architecture): A global event or channel between modules where an import would do, away from
  a real system boundary.
- **blocking** (AGENTS.md § Architecture): Host or transport code that dedupes the statements a resubscribed statement
  subscription brings back.
- **blocking** (AGENTS.md § Project): Code that trusts a server's or gateway's answer without proof, which puts a server
  in the trust path.
- **blocking** (AGENTS.md § Architecture): A call across layers that is not safe to repeat or overlap, or does the work
  more than once.
- **blocking** (AGENTS.md § Architecture): A layer that waits to be asked before recovering from its own failures, or
  does not report its status to the layer above.
- **major** (AGENTS.md § Architecture, Tools:): A hand-rolled queue, in-flight flag, retry timer or concurrency limit
  instead of `createAsyncTaskPool` from `@dotli/shared`.
- **major** (AGENTS.md § Code style, General:): A build plugin, startup trick, lint allow-list, lazy split or extra
  package that a plain website would not need, outside iframe messaging, the sandbox and product isolation, and chain
  connections.

## Placement

- **major** (docs/code/placement.md § Cut rules): Chrome that only lays out one app's page placed in `@dotli/ui`, or a
  domain-free mechanism under it kept in the app.
- **major** (docs/code/placement.md § Cut rules): A building block that implements a whole flow, such as a multi-step
  sign-in modal, a settings panel with its own actions or a full chat panel, or a flow placed in `@dotli/ui`.
- **major** (AGENTS.md § Project): Recovery-phrase sign-in offered anywhere but the debug panel, such as the sign-in
  page, the landing dialog or a product prompt.

## Package surfaces

- **major** (docs/code/placement.md § Inside a package): A package that exposes a module other than its `src/index.ts`
  or the entries `docs/code/placement.md` names.
- **major** (docs/code/placement.md § Inside a package): An import of another package's internal module.
- **major** (AGENTS.md § Code style, Comments and docs:): A change to a package's responsibility, design, public API or
  entry points with no `README.md` update in the same commit.
- **major** (AGENTS.md § Code style, Packages:): A `package.json` without `sideEffects`.
- **major** (AGENTS.md § Code style, Packages:): A relative import without the `.js` extension.

## Lazy loading

- **major** (docs/code/placement.md § Cut rules): What a visit may never open, such as a panel's content or the debug
  panel, imported eagerly instead of through `lazy()` or a loader in `src/lazy.ts`.
- **major** (docs/code/placement.md § Cut rules): A hand-made split or lazy load of a component a visit opens anyway,
  where importing it where it is used lets the bundler split chunks.

## Complexity

Complecting is invisible to every other row here. It breaks no import rule, lands in the right package and passes lint.
It is also the one defect whose cost is paid entirely after merge, which is why review is the last gate that can see it.
Size is not the test: three lines qualify, and a 90-file rename may add none. Complecting, blast radius, frame and layer
are defined in `docs/code/glossary.md`.

- **major** (docs/code/glossary.md § Change size): A new flag, mode or branch parameter added to a path other callers
  already share, not named in the design or plan. Test before flagging: do two call sites pass different values, and do
  the two branch bodies share little? Then two behaviours are braided into one path, and the fix is two functions, not a
  parameter. Not a finding when the branch is a genuine runtime condition the callers cannot know. When every caller
  passes the same value today, it is a dead option, a **minor** finding.
- **major** (docs/code/glossary.md § Change size): A value threaded through call sites that only forward it and never
  read it. Forwarding is the signature of complecting: those files changed because the value is braided into the call
  chain, not because they use it. Supply the value at the layer that owns it, so intermediate callers stop carrying it.
- **major** (docs/code/glossary.md § Change size): A new field on a shared type that most consumers ignore, or one whose
  meaning depends on another field's value. That is two independent concerns in one type. Split the type or model the
  pair as a discriminated union.
- **minor** (docs/code/glossary.md § Change size): The diff's radius contradicts the stated intent. The design, plan or
  PR description frames the change in one layer's vocabulary and the diff spans three or more layers, or reaches public
  surfaces the frame never mentioned. The gap is not itself a defect. The finding is that it was never surfaced for a
  decision. Propose staging it into reviewable PRs, and check whether the step 2 size probe (`architecture` skill)
  recorded the radius at all. Never blocking, since at review time that cost is already sunk.
- **minor** (.claude/skills/architecture/SKILL.md § Reviewing and fixing): A `TODO` or follow-up comment covering braid
  the diff adds is a finding, fixed in this branch.

When you cite a rule, quote `file:line`, state the rule in one line with its doc and section, and suggest the concrete
fix. Group findings by theme and end with the blocking, major and minor counts.
