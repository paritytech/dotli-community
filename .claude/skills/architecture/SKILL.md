---
name: architecture
description: >-
  Use before any non-trivial change to code in `apps/`, `packages/` or `config/`, such as new code, a new, moved or
  renamed file, a new abstraction, extended behaviour or a refactor that moves logic. The single entry point that
  decides what the change is and where it goes before any file path is chosen, then builds it in small slices the owner
  steers. Skip for a trivial edit as `docs/code/glossary.md` defines it.
---

# Architecture

The first step for any non-trivial change. It frames, sizes and places the change, then writes a short design. The
change is built in slices the owner steers, and one review closes it.

- **Trivial or not** (docs/code/glossary.md § Change size). A trivial edit skips this skill. If you are unsure, it is
  non-trivial.
- **Steering over planning.** The design settles decisions, never code. Code is shaped in slices the owner reads, so
  there is no plan document, no plan review and no batch review.
- **This skill replaces the superpowers process for a change.** Never invoke `superpowers:brainstorming`,
  `superpowers:writing-plans` or `superpowers:subagent-driven-development` inside it.

## Who runs this skill

The `architect` agent (`.claude/agents/architect.md`) runs the steps, so that its context holds one change alone. Side
questions and other work stay in the main session.

**The main session** never runs the steps and does no framing, reading or exploring first. If its own
`docs/_plans/project-agent-<session id>.md` exists, with `<session id>` from `$CLAUDE_CODE_SESSION_ID`, a change is
already running: route the request by the rules of `CLAUDE.md` § Project agent. Another session's file does not count.
Otherwise:

1. Dispatch `Agent` with `subagent_type: "architect"` in the background. Pass no `model` and no `effort`. Its prompt is
   the owner's request verbatim, as `OWNER: <text>`, plus the paths of any file the owner attached.
2. Write `docs/_plans/project-agent-<session id>.md`: the agent ID from the dispatch result, the date, and the request
   in one line.
3. Tell the owner in one line that the change runs in the project agent, then stop.

**The `architect` agent** runs every step from the frame to `DONE`, in one context. Each "ask the owner", "stop" or
"owner approves" here is a message with the matching tag of its agent definition. A gate ends the agent's turn, never
its run.

### A staged change

When the owner stages a change at step 2, the architect writes `docs/_plans/<topic>-roadmap.md` before any design. It
holds:

- the goal (step 1)
- the stages in order, each as one frame sentence with its layers and its share of the goal
- a `Carries` section for facts a later stage needs, such as a contract, a seam or a measured cost

The owner's decisions go to the oracle, not the roadmap. A roadmap written before the oracle existed keeps its `Rules`
section, and those rules bind its stages.

The roadmap is a gate the owner approves. The agent that wrote it then ends with `DONE`. Each stage is its own change
with its own `architect`, which runs steps 1 to 6 for that stage alone. Its first message names the roadmap and the
stage, with the owner's roadmap approval, which starts the stage and passes none of its gates. Before `DONE` it marks
the stage done in the roadmap, which needs its share of the goal met or accepted by the owner, and adds to `Carries`
what later stages need. The main session then starts the next stage (`CLAUDE.md` § Project agent).

## The lifecycle

1. Frame the change and write its goal.
2. Size it. A radius that contradicts the frame, or added braid, stops for the owner, who may stage the change.
3. Place it.
4. Write the design. The owner approves it.
5. Build it in slices. Each slice is one commit, and the owner says go or names a fix.
6. Review it, fix what the review confirms, write the outcome record and send `DONE`.

At any step, a question about how to build goes to the oracle first.

## Decisions and the oracle

How the owner solves recurring problems is precedent. The `oracle` agent (`.claude/agents/oracle.md`) keeps it as rules
for scenarios in `docs/decisions/` and decides how the store is laid out and searched. Nothing else reads or writes the
store, and no session reads it at start. Dispatch a fresh oracle for each call.

**What to build is the owner's alone.** Ask these straight as a `QUESTION`, and record nothing, since they bind this
change only:

- the goal, and any cut to it
- the change's requirements and scope
- the step 2 stop, and a radius that turns out well beyond what step 2 measured
- a request outside this change, and a file that changed under you

**How to build goes to the oracle first.** Any other question for the owner, such as where a module goes, what an
interface between layers looks like or how a failure is handled, goes to the oracle as an `ASK`. An `ASK` holds:

- the question
- the situation in general terms, as a shape another change could meet, not this change's files
- the options, unranked
- the paths the oracle may read to judge the case

The oracle answers one of two ways:

- `PRECEDENT`: take the option it names, and cite its rules in the next `APPROVAL`. No question goes to the owner.
- `ASK_OWNER`: ask the owner as a `QUESTION`, with your recommended option first. Quote the oracle's closest rules, and
  the condition that differs for each, beside the options.

**Record the owner's answers on how to build.** Send the oracle a `RECORD` when:

- the owner answers a `QUESTION` that came from `ASK_OWNER`
- a steering fix states a preference beyond its own lines, such as "we don't do X here"
- the owner overturns a call made by precedent

A `RECORD` holds the question, the options, the owner's words verbatim and the source (the design path or PR). For an
overturn it also names the overturned rule. The oracle keeps only what reaches beyond this change, so it may answer
`NOT_KEPT`.

**Your preference never reaches the oracle.** An `ASK` lists the options in no ranked order and with no lean in their
wording. A `RECORD` carries the owner's choice, never the option you recommended. A preference in the brief anchors the
oracle on your reading, and the store would fill with your judgment instead of the owner's.

**The oracle never commits.** Stage its changes under `docs/decisions/` with the current slice commit, or in a commit of
their own when no slice is open. When the oracle says a layout change is due, send it a `LAYOUT` call between slices,
and commit the result on its own, named in the next `APPROVAL`.

A rule the oracle names is always cited where it is used, never applied silently.

## Step 1: Frame and goal

State the change in one sentence in the vocabulary of one package or app. If you cannot (two vocabularies, or the actor,
trigger or resulting state is unclear), run event storming with the owner first (docs/abstract/event-storming.md § For
Claude). Do not guess the package.

Then write the goal: the end state the owner's request asks for, as a check a reader can run against the code once the
change is done, such as "no module the audit names keeps a lifecycle phase outside one state value". Quote the owner's
words beside it. Never narrow it to what is easy to prove. The goal stays fixed for the whole change:

- The `reviewer` checks the code against it, and `DONE` reports each item as met or not met.
- Only the owner narrows it. A cut is a `QUESTION` that shows the goal before and after, and never goes to the oracle.
  The design records the cut with the owner's words.
- In a staged change the roadmap holds the goal, and a stage copies its share from the roadmap without rewriting it.

## Step 2: Size

The frame is not an estimate. The cost lives in the braid the concern is already caught in. Run the probe
(docs/abstract/simple-vs-easy.md § The probe) before the design:

- Measure the blast radius with LSP `findReferences`. Count files and layers (docs/code/glossary.md § Scope). Never
  guess the count.
- Judge whether the change adds braid (docs/code/glossary.md § Change size), such as a flag or branch on a shared path.
- Report both in the three lines the probe defines (docs/abstract/simple-vs-easy.md § For Claude).

If the radius contradicts the frame or the change adds braid, stop and give the owner 2 or 3 options with costs, even
when the diff would be tiny. Staging the change, decomplecting first and accepting it are the usual options.

## Step 3: Place

Place the change with `docs/code/placement.md`:

- § Which package or app, for the package or app.
- § Inside an app and § Inside a package, for the folder and file.
- § Cut rules, for where one concern ends and the next begins.

If nothing fits, ask the oracle, then the owner (docs/code/placement.md § No home found). Never invent a package or a
file to resolve it.

## Step 4: Design

Clarify what the frame leaves open, one question at a time, sorted as "Decisions and the oracle" sets. Then write
`docs/_plans/<topic>-design.md`, at most about 60 lines:

- the frame, and the goal with the owner's words
- the placement, and the files expected to change
- the interfaces between layers, and what happens when each layer fails
- what is out of scope
- open questions, each answered or left to a named slice

Tasks, code snippets, RFC 2119 keywords and per-file steps stay out of it. They are decided in code, where the owner
steers them.

Before presenting it, check every mechanism the design relies on in the code that provides it, `node_modules` included:

- the seam exists
- the call or library does what the design says
- its cost is what the design says

`document-review` is optional. Its asks go to the owner as `QUESTION`s. The owner approves the design, and no code is
written before that. An agent that runs in a worktree writes its design and review files under its own worktree.

## Step 5: Slices

Build the change as a run of slices. A slice is one commit the owner can read in a few minutes, usually up to four
files, that leaves typecheck and tests passing. Slices that set an interface between layers come before the slices that
use it.

**Writing a slice.** Write it yourself when it is small, or dispatch one fresh implementer ("Subagents"). Every line
follows `docs/code/style.md` and the Architecture gate. Tests follow (docs/code/placement.md § Inside a package) for
where they live and (AGENTS.md § Code style, Tests:) for how they behave. The implementer bans in "Subagents" bind you
too.

**Judgment calls.** A call that shapes a public surface, a file's responsibility, a failure path or what a test covers
goes to the oracle as an `ASK`. A smaller call is yours. List it as own judgment when the owner might decide it
otherwise. An implementer that stops at a call gets the answer through `SendMessage` and goes on, and the smaller calls
it lists in its report are yours to list.

**The stop.** After each slice commits, stop with an `APPROVAL` that holds:

- the commit hash and its file stat
- what changed and why, in a few lines
- each judgment call with its basis, the precedent rules or "own judgment"
- the oracle's changes to `docs/decisions/`, if any
- what the next slice does

The owner says go, or names a fix and its scope. A fix lands as its own commit, and the stop repeats for it. A fix that
states a preference beyond its own lines is also a `RECORD`. Every slice stops, unless the owner says otherwise for this
change.

**A discovery.** Update the design in place, and name the change in the next `APPROVAL`. A discovery that changes the
goal, or a radius well beyond what step 2 measured, stops as a `QUESTION`. One that changes the placement or an
interface between layers goes to the oracle as an `ASK` first.

## Step 6: Review and fix

After the owner's go on the last slice, dispatch a fresh subagent that runs the `reviewer` skill. Its brief names the
branch, the design path, and by hash any commit on the branch this change did not make. It writes
`docs/_reviews/<topic>-review.md`, with the same `<topic>` as the design.

**Verify before fixing.** After every reviewer run, full or scoped, one fresh verifier gets the review file and the IDs
of the run's blocking and major findings. It reads the code each one cites and tries to refute it. A finding is
confirmed only when the code shows the defect at its `file:line`, and the verifier quotes those lines. It marks each
finding confirmed or dropped in the review file, with one line why. It never adds a finding or changes a severity. A
dropped finding is never fixed or raised again. Minor findings skip verification.

**Fix.** Every confirmed blocking or major finding, and every minor one, is fixed in this branch, in one fresh dispatch
or by you when small. A fix that would change the goal, the placement or an interface between layers follows "A
discovery" in step 5 first. The fixer may close a minor finding when the fix would make the code worse, or when the
finding misreads what the code is for, with the reason in one line under the finding. "It is minor" and "out of scope"
are not reasons. Read each closure and send back any whose reason does not hold. A fix that changes only docs or
comments ends the review.

**Scoped re-review.** A fresh subagent runs the `reviewer` skill on the fix's commit range, with the IDs of the findings
it answers. It checks that each is fixed and audits the fix's diff. After a blocking or major fix it also reads every
file that uses a symbol the fix changed, found with LSP `findReferences`. It raises no finding the review file already
holds.

**Cap: two runs**, full and scoped together. Minor findings of the second run get one sweep and no re-review. If it
still has confirmed blocking or major findings, stop as `BLOCKED`. The owner decides: fix them once with no third run,
or accept them.

**The outcome record.** When the review ends, append `### Outcome` to the review file. It records and judges nothing:

- the slices, and the fixes the owner asked for at their stops
- each question asked of the owner, and whether the owner took your recommended option
- the calls the oracle answered with `PRECEDENT`, and the overturns among them
- the oracle's dispatches
- every finding by ID with its outcome, such as fixed or dropped by verification
- the time from your first message to the last commit

The record is statistics for the owner, who uses it to adjust this flow. No agent reads it back. The oracle never sees
it, and no brief points at it. Token counts come from the session logs afterwards.

Then send `DONE`. Finishing the branch (merge or PR) is a separate step the owner starts.

## Shared rules

### The Architecture gate

The `## Architecture` section of `AGENTS.md` is a gate, not a nicety. Every implementer brief states it outright:

- each layer owns one responsibility a reader can name from its module
- the interfaces between layers are small and explicit
- each layer recovers from its own failures without waiting to be asked and reports its status up
- calls across layers are idempotent

Where a fix would add a special case, move the responsibility to the layer that owns it.

### A request that breaks a convention

When the owner asks for something that breaks a convention of the repo, do not just comply. Name the convention, show
its precedent, then ask. Check first whether the current placement or pattern matches a convention
(docs/code/placement.md § Cut rules).

### Subagents

Every subagent is fresh: `Agent` with a named type, never a fork. Only you dispatch. "Session" means passing no `model`,
so the seat runs on your model.

- **A side investigation**, such as the call sites of a symbol or how a module recovers. Locate code with a fresh
  `Explore` on its own default. Read how it behaves with a fresh `general-purpose` on session, or inline. Inputs: one
  question, the paths to start from and the answer format.
- **The oracle**: `subagent_type: "oracle"`, on its own model. Input: one `ASK`, `RECORD` or `LAYOUT`.
- **A slice implementer**: `general-purpose`, on `sonnet` when the brief fully defines the slice, such as a rename or a
  mechanical reshape, and on session otherwise. Inputs: the design path, the slice's goal and files in a few lines, what
  earlier slices found that it needs, and the bans below.
- **The reviewer, a verifier, a fix of blocking or major findings, a scoped re-review**: session. **A minor sweep**:
  `sonnet`.

Briefs carry paths and inputs, never your verdicts. A seat writes its full report to the file its brief names. Its final
message, at most 10 lines, gives that path and its counts.

Every brief of a seat that reads code says how it looks up symbols:

- Load LSP with `ToolSearch` (`select:LSP`) before the first lookup.
- Answer a symbol question with LSP: `findReferences` for its users, `workspaceSymbol` or `goToDefinition` for where it
  is defined, `hover` for its type. Send independent calls in one turn.
- Grep only plain text, config, Markdown and non-TypeScript files, or after an LSP call fails, and name that failure in
  the report.

Every implementer brief carries these bans in words:

- Read `docs/code/style.md` before the first edit, and write every line to it.
- At a call the brief does not settle that shapes a public surface, a file's responsibility, a failure path or what a
  test covers, stop and report it with the options you see. Never pick one. List the smaller calls you made in your
  report.
- No size, perf or measuring builds.
- No slow Playwright suite before a commit. Commit after the fast checks, and run that suite on its own.
- No sleeps or fixed timeouts. Wait on a readiness signal.
- A rewrite that repeats one shape across many sites is one `perl -pi` or `node` script that fails when a pattern
  matches nothing, followed by a read of its diff.
- Stage only your files, by path.

## Red flags

- **Code before an approved design.**
- **A task list, code snippets or per-file steps in the design.** The slices decide them.
- **A slice the owner cannot read in a few minutes**, or two slices with no stop between them that the owner did not
  allow.
- **A question about how to build that the oracle never saw**, or a call decided by precedent without its rule.
- **A question about what to build sent to the oracle**, or its answer recorded as precedent.
- **Your recommended option in an `ASK` or a `RECORD`.**
- **Treating the frame as an estimate, or "it's only a small diff".** Diff size says nothing about braid
  (docs/abstract/simple-vs-easy.md § The classification). Measure the radius before the design.
- **Typing a path in `apps/`, `packages/` or `config/` without having read `docs/code/placement.md`.**

## See also

- `.claude/agents/oracle.md`: how the owner's decisions are stored and matched.
- `docs/abstract/simple-vs-easy.md`: the step 2 size probe, blast radius against braid.
- `docs/abstract/event-storming.md`: finding the seam when the frame does not fit one vocabulary.
- `docs/code/glossary.md`: the workflow thresholds.
- `docs/code/placement.md`: where code and files go.
- `docs/code/style.md`: how code is shaped and how pieces combine.
- `docs/code/rule-extraction.md`: where a correction goes.
- `reviewer` skill: audits the implementation against the design and the checklists.
