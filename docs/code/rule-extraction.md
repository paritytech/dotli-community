# Rule extraction

A correction the owner makes in one session ends with that session, so the next session repeats the mistake. Rule
extraction turns a durable correction into a durable rule. The rule is written into its owner doc and mirrored into a
reviewer checklist, so it is enforced from then on.

Code and workflow corrections become repo rules, never agent memory. This holds in a skill run and outside one.

## When to run

Run it in two cases:

- At the end of a pass of the `architecture` skill (planning) or of an implementation, after the owner has accepted the
  plan or the implementation.
- Whenever the owner corrects a code or workflow choice outside a skill run. The rule goes to the repo through this
  procedure, never to agent memory.

Run it only when the session holds **substantive** corrections, meaning more general than the task at hand:

- "X should always go in Y, not Z." or "We don't do Z, we use W."
- A direct edit that reverses a choice (renaming a type, moving a file, changing a pattern).
- "When you do X, also do Y." or "Don't bake Z into the model, extract it."
- A lint warning the owner explicitly endorsed as a general rule.

**Ignore** task-specific corrections: a single variable name, one magic number, the exact wording of one string. They do
not generalize. When there are no substantive corrections, stay silent and skip the run. Don't invent candidates to have
something to propose.

## Procedure

1. **Re-read the session.** Collect each substantive, generalizable correction.
2. **Form candidate rules.** One line each, prescriptive ("do X when Y" or "don't do Z"), tagged with a severity
   (`blocking`, `major` or `minor`), with a target doc and heading from `## Where rules land` and a one-line why,
   quoting the owner's rationale where given. Cap the list at five per session. If more surface, present the top five
   and note that the rest are in the conversation.
3. **Ask one candidate at a time** through `AskUserQuestion`:

   > **Rule:** `<severity>`, <one-line rule> **Why:** <rationale, quoting the owner where possible> **Where:**
   > `<doc § heading>` and the matching checklist row

   The options are `Add as proposed`, `Add with my wording` and `Skip, not a general rule`.

4. **On approval,** edit the owner doc named in `## Where rules land`:
   - Add the rule under the matching heading or label. Each rule has exactly one owner doc.
   - Add a one-line row to the mirror checklist, citing the owner as `(<doc> § <heading>)` and, for AGENTS.md
     `## Code style`, with the label.
   - If the rule can be checked mechanically, tell the owner it is an ESLint candidate. Do not change a lint rule in
     this run.
   - If the rule changes what a package owns or may import, update that package's `README.md` or `eslint.config.js` and
     the summary in `docs/code/placement.md` in the same commit.
   - Confirm what was added and where.
5. **On `Add with my wording`,** ask the owner to dictate and add the rule in their phrasing.
6. **On `Skip`,** drop the candidate and don't raise it again this session.

## Where rules land

| The correction is about                               | Owner doc                                                                                                         | Checklist mirror                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A product rule (trust path, what dotli is and is not) | `AGENTS.md` `## Project`                                                                                          | `docs/claude/architecture-checklist.md`                                        |
| Layer behaviour, calls across layers, recovery        | `AGENTS.md` `## Architecture`                                                                                     | `docs/claude/architecture-checklist.md`                                        |
| A shared tool choice                                  | `AGENTS.md` `## Architecture`, `Tools:`                                                                           | `docs/claude/architecture-checklist.md`                                        |
| Import style, `sideEffects`                           | `AGENTS.md` `## Code style`, `Packages:`                                                                          | `docs/claude/architecture-checklist.md`                                        |
| A general code rule                                   | `AGENTS.md` `## Code style`, `General:`                                                                           | `docs/claude/code-checklist.md`                                                |
| A TypeScript, errors, logging or metrics rule         | `AGENTS.md` `## Code style`, `TypeScript:`                                                                        | `docs/claude/code-checklist.md`                                                |
| A UI, styles or icons rule                            | `AGENTS.md` `## Code style`, `UI:`                                                                                | `docs/claude/code-checklist.md`                                                |
| A comment, doc or prose rule                          | `AGENTS.md` `## Code style`, `Comments and docs:`                                                                 | `docs/claude/code-checklist.md`                                                |
| A test rule                                           | `AGENTS.md` `## Code style`, `Tests:`                                                                             | `docs/claude/code-checklist.md`                                                |
| A commit or PR rule                                   | `AGENTS.md` `## Code style`, `Git:`                                                                               | none                                                                           |
| Where code or files go                                | `docs/code/placement.md`                                                                                          | `docs/claude/architecture-checklist.md`                                        |
| What a package owns or may import                     | that package's `README.md` or `eslint.config.js`, then the summary in `docs/code/placement.md` in the same commit | `docs/claude/architecture-checklist.md`, only when a diff can show a violation |
| A new threshold definition                            | `docs/code/glossary.md`                                                                                           | none                                                                           |
| Workflow or agent behaviour                           | `.claude/skills/architecture/SKILL.md`                                                                            | none                                                                           |

The mirror column is the default. Some rules sit in both checklists, so the checklist whose section fits the diff
surface decides, or the row goes in both where both apply. A checklist row exists only when a diff can show a violation.
A rule that ESLint already enforces gets no row.

## Why mirror into a checklist

There are three enforcement layers, weakest to strongest:

1. **Doc.** Read on demand. A rule that lives only here depends on the agent recalling it.
2. **Checklist.** Cited by the reviewer, so a violation in a diff becomes a finding.
3. **ESLint.** Mechanical and cannot be skipped.

Move every mechanically checkable rule toward ESLint. A rule a linter could check is noted to the owner as an ESLint
candidate, and this procedure changes no lint rule. Keep the doc and the checklist for judgment-call rules that a linter
cannot express. The reviewer is the safety net for everything in between.
