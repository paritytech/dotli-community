---
name: consult-oracle
description: >-
  Use outside the `architecture` skill when a choice about how to build comes up that the owner might make differently
  from you, such as where code or a file goes, which of two shapes to take, how a failure is handled or which concern
  wins a trade-off, and before you ask the owner such a question. Also use when the owner answers or corrects such a
  choice, so the answer is kept. It asks the `oracle` agent for the owner's precedent first, and files what the owner
  says.
---

# Consult the oracle

The owner's way of solving recurring problems is kept as rules in `docs/decisions/`, and the `oracle` agent
(`.claude/agents/oracle.md`) alone reads and writes them. This skill brings that precedent to any session, not only to
an `architecture` run. Inside an `architecture` run, follow its "Decisions and the oracle" instead.

## When to ask

Ask the oracle when you are at a fork about how to build, with real options, where the owner's preference could differ
from yours.

Decide yourself, without the oracle, when:

- an owner doc, a checklist or a lint rule already settles it
- the code around it already shows the pattern, and you follow it
- a test, a probe or a measurement can settle it
- it is one name, one value or one string, with nothing behind it another change could meet

What to build, such as the goal, the scope or a cut to either, is never the oracle's. Ask the owner straight.

## Ask

Dispatch a fresh `oracle` agent (`subagent_type: "oracle"`) with one `ASK`:

- the question
- the situation in general terms, as a shape another change could meet, not this task's files
- the options, unranked and worded with no lean
- the paths the oracle may read to judge the case

Keep your recommendation out of the `ASK`. A lean anchors the oracle on your reading instead of the owner's.

The oracle answers one of two ways:

- `PRECEDENT: <option>` with the rules it rests on. Take that option without asking the owner, and name the rules when
  you report the work, such as "placed by grouping-source-into-folders".
- `ASK_OWNER` with the closest rules. Ask the owner through `AskUserQuestion`, with your recommended option first, and
  quote each close rule with the condition that differs beside the options.

## Record

Send a fresh `oracle` a `RECORD` when:

- the owner answers a question that came from `ASK_OWNER`
- the owner overturns a call made by precedent. Name the overturned rule.
- the owner corrects a how-to-build choice in a way that reaches beyond this task (docs/code/rule-extraction.md § When
  to run)

A `RECORD` holds the question, the options, the owner's words verbatim and the source, such as the branch or the PR. The
oracle keeps only what reaches beyond this task, so it may answer `NOT_KEPT`.

For a correction, finish with the rest of docs/code/rule-extraction.md § Procedure, which offers a check where one can
hold it.

The oracle never commits. Name the files it changed to the owner, who commits them with the work.
