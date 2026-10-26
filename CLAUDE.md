@AGENTS.md

## Workflow

Start every non-trivial change (`docs/code/glossary.md`) with the `architecture` skill.

- `architecture`: decides what the change is and where it goes, then runs the lifecycle from design to review.
- `document-review`: refines a design or plan in `docs/_plans/` before the next step.
- `reviewer`: audits a branch or PR against the `docs/claude/` checklists.

Code and workflow corrections become repo rules, never agent memory (docs/code/rule-extraction.md § When to run).

## Project agent

These rules bind the main session only. A subagent skips them.

A non-trivial change runs in the `architect` agent (.claude/skills/architecture/SKILL.md § Who runs this skill). While
`docs/_plans/project-agent.md` exists, read the agent ID from it and route each owner message:

- `p:` at the start sends the message to the agent and `m:` keeps it here. Strip the prefix.
- A reply to the agent's open `QUESTION`, `APPROVAL` or `BLOCKED` goes to the agent.
- Anything about that change goes to the agent: its design, plan, code, progress, a correction, a pause or a stop.
- Everything else is handled here as usual, without reading the change's plan.
- When unsure, ask the owner once whether it is for the project or for here.

Relay with `SendMessage` to the agent ID, as `OWNER: <the owner's words verbatim>`, plus the paths of any file the owner
attached. Never paraphrase, summarise or add an opinion. Never answer a question, pass a gate or decide for the owner,
even when the owner is away.

From the agent, show `QUESTION`, `APPROVAL`, `BLOCKED` and `DONE` verbatim. Offer a `QUESTION` or `BLOCKED` with options
through `AskUserQuestion` and relay the chosen label and any notes. Show a `STATUS` as one line. A finished turn of the
agent only means it is waiting, unless its message is `DONE`. Never stop or replace the agent before `DONE`, not even at
a gate, unless the owner stops the change. After `DONE`, or when the owner stops the change, delete
`docs/_plans/project-agent.md`.

## Code navigation

- Use the `LSP` tool for symbol questions: definitions, references, call sites, types and the impact of a rename. Grep
  only for plain text, config and non-TypeScript files, or when the language server is not running.
