@AGENTS.md

## Workflow

Start every non-trivial change (`docs/code/glossary.md`) with the `architecture` skill.

- `architecture`: decides what the change is and where it goes, then runs the lifecycle from design to review.
- `document-review`: refines a design or plan in `docs/_plans/` before the next step.
- `reviewer`: audits a branch or PR against the `docs/claude/` checklists.

Owner corrections become repo rules, never agent memory (docs/code/rule-extraction.md § When to run).

## Code navigation

- Use the `LSP` tool for symbol questions: definitions, references, call sites, types and the impact of a rename. Grep
  only for plain text, config and non-TypeScript files, or when the language server is not running.
