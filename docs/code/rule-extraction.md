# Rule extraction

A correction the owner makes in one session ends with that session unless the repo keeps it. This procedure decides
where it is kept.

Code and workflow corrections go to the repo, never agent memory. This holds in a skill run and outside one.

## Where a correction goes

A correction has three possible homes:

1. **A decision.** The default. A fresh `oracle` keeps the technique or priority behind it as a rule for its
   scenario, or keeps nothing when it only settles the task at hand. A later session meets the rule only when a question
   it answers comes up, so it costs no context at start.
2. **A check.** A lint rule or a test, where one can express the correction. It decides every case without being read.
3. **A rule.** An owner doc and a checklist row, which every change is held to. Only when the owner says the
   correction binds every change.

## When to run

- **In an `architecture` skill run**, at the moments its "Decisions and the oracle" lists.
- **Outside a skill run**, whenever the owner corrects a code or workflow choice, through the `consult-oracle` skill.

Outside a skill run, run it only for **substantive** corrections, meaning more general than the task at hand:

- "X should always go in Y, not Z." or "We don't do Z, we use W."
- A direct edit that reverses a choice (renaming a type, moving a file, changing a pattern).
- "When you do X, also do Y." or "Don't bake Z into the model, extract it."
- A lint warning the owner explicitly endorsed as a general rule.

**Ignore** task-specific corrections: a single variable name, one magic number, the exact wording of one string. They do
not generalize. When there are no substantive corrections, stay silent and skip the run. Don't invent candidates to have
something to propose.

## Procedure

1. **Record it.** Send a fresh `oracle` a `RECORD`: the question the correction answers, the options, the
   owner's words verbatim and the source (a design path, a PR or the branch). Asking the owner is not needed, since the
   oracle's change shows in the diff. Outside a skill run, name the files the oracle changed to the owner, who commits
   them with the work.
2. **Offer a check.** When a lint rule or a test can express the correction, propose it to the owner, through
   `AskUserQuestion` or, in a skill run, a `QUESTION`. On approval, add it in the current change. Then send the oracle a
   `RECORD` with the rule's name and the check, so the rule is marked as enforced.
3. **Promote it to a rule** only when the owner says it binds every change:
   - Add the rule to the owner doc and heading `## Where rules land` names. Each rule has exactly one owner doc.
   - Add a one-line row to the mirror checklist, citing the owner as `(<doc> § <heading>)` and, for AGENTS.md
     `## Code style`, with the label.
   - If the rule changes what a package owns or may import, update that package's `README.md` or `eslint.config.js` and
     the summary in `docs/code/placement.md` in the same commit.
   - Confirm what was added and where.

## Where rules land

| The correction is about                               | Owner doc                                                                                                         | Checklist mirror                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A product rule (trust path, what dotli is and is not) | `AGENTS.md` `## Project`                                                                                          | `docs/claude/architecture-checklist.md`                                        |
| Layer behaviour, calls across layers, recovery        | `AGENTS.md` `## Architecture`                                                                                     | `docs/claude/architecture-checklist.md`                                        |
| A shared tool choice                                  | `AGENTS.md` `## Architecture`, `Tools:`                                                                           | `docs/claude/architecture-checklist.md`                                        |
| Import style, `sideEffects`                           | `AGENTS.md` `## Code style`, `Packages:`                                                                          | `docs/claude/architecture-checklist.md`                                        |
| A general code rule                                   | `AGENTS.md` `## Code style`, `General:`                                                                           | `docs/claude/code-checklist.md`                                                |
| How code is shaped and combined                       | `docs/code/style.md`, the matching section                                                                        | `docs/claude/code-checklist.md`                                                |
| A dotli errors, logging or metrics rule               | `AGENTS.md` `## Code style`, `TypeScript:`                                                                        | `docs/claude/code-checklist.md`                                                |
| A UI, styles or icons rule                            | `AGENTS.md` `## Code style`, `UI:`                                                                                | `docs/claude/code-checklist.md`                                                |
| A comment, doc or prose rule                          | `AGENTS.md` `## Code style`, `Comments and docs:`                                                                 | `docs/claude/code-checklist.md`                                                |
| A test rule                                           | `AGENTS.md` `## Code style`, `Tests:`                                                                             | `docs/claude/code-checklist.md`                                                |
| A commit or PR rule                                   | `AGENTS.md` `## Code style`, `Git:`                                                                               | none                                                                           |
| Where code or files go                                | `docs/code/placement.md`                                                                                          | `docs/claude/architecture-checklist.md`                                        |
| What a package owns or may import                     | that package's `README.md` or `eslint.config.js`, then the summary in `docs/code/placement.md` in the same commit | `docs/claude/architecture-checklist.md`, only when a diff can show a violation |
| A new threshold definition                            | `docs/code/glossary.md`                                                                                           | none                                                                           |
| Workflow or agent behaviour                           | the skill or agent file that runs that workflow                                                                            | none                                                                           |

The mirror column is the default. Some rules sit in both checklists, so the checklist whose section fits the diff
surface decides, or the row goes in both where both apply. A checklist row exists only when a diff can show a violation.
A rule that ESLint already enforces gets no row.

## Why mirror into a checklist

There are three enforcement layers, weakest to strongest:

1. **Doc.** Read on demand. A rule that lives only here depends on the agent recalling it.
2. **Checklist.** Cited by the reviewer, so a violation in a diff becomes a finding.
3. **ESLint.** Mechanical and cannot be skipped.

Move every mechanically checkable rule toward ESLint. A correction a linter could check becomes a lint rule once the
owner approves it (§ Procedure, step 2). Keep the doc and the checklist for judgment-call rules that a linter
cannot express. The reviewer is the safety net for everything in between.
