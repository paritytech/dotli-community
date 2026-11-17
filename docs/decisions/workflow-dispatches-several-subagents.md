# A workflow dispatches several subagents

You are writing or tuning a workflow that dispatches several subagents for one change, such as one that searches, one
that writes code, one that checks and one that rates. Each one needs some of the repo's docs. The question is which
agent loads the code-writing docs: the code style, placement, the Architecture gate and the oracle protocol for
judgment calls. It is also whether the agent that runs the loop may read and write code itself.

## How to resolve

1. Give code writing to one agent type that carries all the code-writing context. Every workflow that writes code
   dispatches that agent, rather than having its own roles write code.
2. Load every other role with only the docs its role needs. A role that does not write code never loads the code style
   or the other code-writing docs, and never reads the whole skill.
3. Give each role a brief file that holds only what that role reads, and dispatch the role with it.
4. Run the loop in a dedicated controller agent, in a fresh context. It dispatches the roles and reads no code itself.

The owner's reason: the code-writing context belongs in one place that every code-writing workflow shares, and no other
agent should pay for docs it does not need.

## Example

```text
agents/
  loop-runner.md        runs the rounds in a fresh context, dispatches, reads no code
  code-writer.md        loads the style guide, placement, the Architecture gate and the oracle protocol
skills/tidy-pass/
  SKILL.md              the loop, read by the loop runner
  briefs/
    searcher.md         what the searcher reads, and nothing else
    checker.md          what the checker reads, and nothing else
```

Not this: every role reads `SKILL.md` and the style guide, and the agent that runs the loop also reads the modules and
edits them on top of whatever its session already held.

## Cases

- A token-cost review of a `reduce-complexity` run found that every subagent re-read the whole skill and the style
  guide, and that the controller ran the loop on top of a large unrelated context. The owner added an orchestrator agent
  type to run the loop and an `implementer` agent type that writes the code for both `architecture` and
  `reduce-complexity`. Each other role got a brief file with only what it reads. The same change merged one round's
  rater into the next round's scout. (main, reduce-complexity token review, 2026-11-17)

Status: active
