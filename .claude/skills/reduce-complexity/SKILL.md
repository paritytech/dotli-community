---
name: reduce-complexity
description: >-
  Use when simplifying, cleaning up or refactoring code, when asked to make a module or feature clearer or smaller, or
  when rating how simple code is. Also use when code fights its own structure: guards for states that should not exist,
  values passed through layers that never read them, flags and modes that patch a wrong split, sync code between two
  copies of one fact, or a mechanism such as a state machine where plain code would do. It covers compatibility paths
  whose producer may be gone and trimming what loads at boot.
---

# Reduce complexity

Most complexity is code that serves other code rather than the job. A run finds the shape in which that code has no
reason to exist, moves the code there, then trims what is left. It works in rounds, and each round passes through four
fresh agents:

- a scout rates the module and proposes boldly
- an author proves each proposal strictly
- a verifier tries to break the proofs
- an implementer applies what holds

Searching boldly and proving strictly pull against each other in one head, and a judge who believes a proof cannot test
it. So each role is its own agent, and each reads only its own brief file beside this one.

## Who runs this skill

The `complexity-orchestrator` agent (`.claude/agents/complexity-orchestrator.md`) runs the loop, in a context that holds
this run alone.

**Whoever is asked to run this skill** dispatches it and runs nothing of the loop, not even a first read of the modules:

1. Dispatch `Agent` with `subagent_type: "complexity-orchestrator"` in the background. Pass no `model` and no `effort`.
   Its prompt is the owner's request verbatim, as `OWNER: <text>`, plus the paths of any file the owner attached.
2. In the main session, track the agent and relay to it as `CLAUDE.md` § Project agent says. Another agent relays as
   that section says the main session does.
3. Tell the owner in one line that the run is in the orchestrator, then stop.

**The orchestrator** first adds a worktree for the run on a new branch from the current `main`, with
`git worktree add -b <branch> .claude/worktrees/<name> main`, and names it in every dispatch, the oracle's included. It
reads no module, spec or caller, and no diff of them. It holds paths, counts and scores. Each fact it needs comes from a
role agent's file.

## Roles

| Role        | Agent                   | Reads, beside this file                  | Writes                           |
| ----------- | ----------------------- | ---------------------------------------- | -------------------------------- |
| Scout       | fresh `general-purpose` | `scout.md`, `principles.md`              | `scout-<group>-r<n>.md`          |
| Author      | fresh `general-purpose` | `author.md`, `principles.md`, `rules.md` | `proven-<group>-r<n>.md`         |
| Verifier    | fresh `general-purpose` | `verifier.md`, `rules.md`                | `verdict-<group>-r<n>.md`        |
| Implementer | fresh `implementer`     | `apply.md`                               | commits, `apply-<group>-r<n>.md` |
| Oracle      | fresh `oracle`          | its own store                            | `docs/decisions/`                |

Role files go in the orchestrator's scratchpad, in a folder for the run. A `<group>` is a module, or the few modules one
root spans.

Every role runs on the session model, so pass no `model`. A dispatch prompt holds the brief's path, the worktree, the
modules, the inputs its brief names and the file it writes. It carries nothing of your own reading and none of your
verdicts. The prompt of a scout, an author or a verifier also carries this block as it stands:

> Read your brief and the files it names in one turn. Read each file whole, once, with Read, and read it again only
> after it changed. Send independent reads and lookups in one turn. Keep each command's output under about 20k
> characters, narrowing the path or piping through `head`, so it is never saved to a file. Symbol lookups: load LSP with
> `ToolSearch` (`select:LSP`) before the first lookup, and answer a symbol question with `findReferences`,
> `workspaceSymbol`, `goToDefinition` or `hover`. LSP may not index a worktree. When a call returns nothing, grep and
> say so.

## The loop

Run it per group. Groups run side by side, but implementers that share a worktree run one at a time.

1. **Scout.** It rates the group and proposes. After round 1 it compares with the commit before the previous round and
   judges each of that round's commits. A group at the bar stops here.
2. **Author.** It maps, shapes, trims and proves, with the scout's file and the owner's decisions so far in this run.
3. **Verify.** Drop each proposal the verifier breaks.
4. **Owner.** The owner items are the proposals the author or the verifier marks as the owner's. Read only those items
   of the files. A question about how to build goes to the oracle as an `ASK` first, and its `PRECEDENT` decides the
   item. Send the rest as one `QUESTION`: per item what it deletes, the fact that decides it and the author's
   recommendation. An owner's answer after `ASK_OWNER` goes to the oracle as a `RECORD`, as the `architecture` skill's
   "Decisions and the oracle" says.
5. **Apply.** Dispatch an implementer with the proposals that hold, that the owner approved or that a precedent decided,
   in the author's order, and with the files the oracle changed this round, which it stages with its first commit. It
   hands back a call it cannot settle as a ready `ASK`. Send that to the oracle as it stands and return the answer.
6. **Next round,** at Scout.

Stop a group when a scout rates it at the bar, which is 9, or 9.5 when the owner raises it. Stop early when the author
proves nothing to apply, since what is left is then a matter of taste rather than of reading, and say so. After 3
rounds, a last scout only rates, and a group still below the bar stops with the reason it could not be reached. Scores
are noisy by half a point between rounds, so a group that sways between two scores is at the lower one.

A request only to rate runs one scout that only rates, and no loop.

Before `DONE`, run the functional suite with `npm run test:functional` from the worktree root and read only its summary,
since unit tests pass while a flow across modules breaks. The script builds with the test networks first, as a worktree
has no `.env`.

## Red flags

| Thought                                              | Reality                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| "I'll read the module first to brief the scout well" | The scout looks with its own eyes. You hold paths, counts and scores.      |
| "I'll check this one fact in the code myself"        | Ask the role whose file should hold it. Your context is paid on each turn. |
| "The proof is solid, skip the verifier"              | The author is the worst judge of its own proof.                            |
| "The scout listed it, so it goes in"                 | The author proves it, or drops it with the fact that sank it.              |
| "I scored it 9.5"                                    | Only a fresh scout's score counts. Neither yours nor the author's.         |
