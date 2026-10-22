# Simple vs easy

A sizing framework for a change, run before the design is brainstormed. It answers one question the one-sentence frame
cannot: **what does this actually cost, now and on every change after it?**

External reference: Rich Hickey, "Simple Made Easy" talk (InfoQ, 2011).

## The two axes

They are independent, and collapsing them is the failure this framework exists to prevent.

**Simple or complex** is a property of the **artifact**. _Complex_ is Hickey's `complect`: to braid together. Two
concerns are complected when you cannot change one without touching the other. It is objective and countable: how many
concerns live in the place you are editing, and how many places the concern you are adding lives in.

**Easy or hard** is a property of **you, right now**. Near at hand: familiar, already installed, small effort, short
diff. It is relative and temporary.

A 90-file mechanical rename is **hard and simple**. A three-line flag on a shared path is **easy and complex**. It costs
nothing today and taxes every change that path ever sees again. Judging a change by its diff size measures only the easy
axis.

The trap the framework catches: **framing a change in one sentence is what makes it look easy.** The sentence is about
the concern. The cost is about the braid the concern is already caught in.

## The probe

Three questions. Answer them with **repo evidence, not intuition**. The LSP tool (`findReferences`, `incomingCalls`)
makes blast radius measurable, so guessing it is a choice.

1. **Who must change with me?** List the symbols and public surfaces the change touches. Run `findReferences` on each.
   Count **files** and **layers**. A layer is one package (`packages/*`), one app (`apps/*`) or one `config/*` package
   (`docs/code/glossary.md § Scope`).

2. **Why must they change?** Per call site: does it genuinely _use_ the thing (unavoidable, it asked for this value), or
   is the concern _braided into_ it (it never wanted this value and now must carry it)? Forty sites threading a new
   parameter is not forty units of work. It is the codebase reporting that the value is already complected with its
   callers. **A large radius is a measurement of existing complexity, not a property of your change.**

3. **Am I adding braid or removing it?** Adding: a new flag on a shared path, a new field on a shared type, a new branch
   others must now know about, a parameter threaded through code that has no use for it. Removing: a concern that lived
   in N places now lives in one, or a caller that stops needing to know something. This cost never appears in the
   current diff. It is paid by every future change.

## The classification

The probe places the change in one cell. Each cell has a mandated move.

|                            | **Radius matches the frame**                                         | **Radius contradicts the frame**                                                                                |
| -------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Removes or keeps braid** | Proceed. This is the normal case.                                    | Worth doing, but it is a **project, not a task**: STOP. Report the measured count, propose stages, owner picks. |
| **Adds braid**             | **The trap.** STOP. Name the braid, present the decomplected option. | STOP. Not a judgment call to make alone.                                                                        |

**"Radius contradicts the frame"** is deliberately relative, not a file count. The frame (step 1 of the `architecture`
skill) states the change in **one layer's vocabulary**. If the measured radius spans three layers, or reaches public
surfaces the sentence never mentioned, the frame and the artifact disagree. That gap is the finding. Report the gap, not
a number.

**Why the small-radius, adds-braid cell stops just as hard.** Nothing downstream catches it. The diff is small, the plan
is short, the review passes, the tests are green, and the cost lands on someone else, months later. It is the only cell
that never self-corrects.

**A stop is not a refusal.** It is a report: here is the measured radius, here is what is braided with what, here are
the options and their costs. The owner decides. The framework only refuses to let that decision be made silently by an
agent that framed the task in one sentence and started typing.

## Worked example

This scenario is illustrative. It is not a real branch.

A branch is framed as: _"make the chain connection timeout configurable."_ One sentence, in the vocabulary of one
package, `@dotli/chains`. It reads as bounded. The timeout value lives in `@dotli/config`, and several callers only
forward it to the chain pool without using it.

```
$ git diff --stat main...HEAD | tail -1
 41 files changed, 312 insertions(+), 140 deletions(-)

$ git diff --name-only main...HEAD | cut -d/ -f1-2 | sort -u
apps/host
apps/protocol
packages/bitswap
packages/chains
packages/config
packages/protocol
packages/resolver
packages/storage
```

The frame named one package. The artifact spans eight layers, two of them apps. The gap between those two lines **is**
the finding, and it was available before the first edit. Running `findReferences` on the timeout-carrying symbols would
have reported it in seconds.

Note what the finding is _not_: it is not "this change was wrong." Question 2 is what settles that. Every call site that
had to change because it threads a timeout it never asked for is a site where the timeout was complected with the
caller. The radius is the measurement of that pre-existing braid. The right response might be to proceed in staged PRs,
or to decomplect first (the pool reads the timeout from `@dotli/config` itself, so callers stop forwarding it) and
change second. That is a decision to take deliberately at 41 files, not to discover at file 30.

## Rationalizations to flag

Each of these is the easy axis arguing it is the simple axis:

| Thought                                          | What it actually means                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| "It's just one more parameter"                   | Complecting every caller with a value it does not own.                                 |
| "I'll add a flag so both behaviors work"         | Two behaviors braided into one path.                                                   |
| "Just add a fallback here"                       | Policy braided into mechanism.                                                         |
| "It's the same shape as what's already there"    | Familiar is not simple. Consistency with a complected pattern propagates the braid.    |
| "It's only a small diff"                         | Diff size is the easy axis. It reports nothing about braid.                            |
| "I'll clean it up in a follow-up"                | The braid ships and the follow-up is unfunded.                                         |
| "Most of those files are just call-site updates" | That is question 2's answer, and it is the evidence _for_ complecting, not against it. |

## For Claude

Run the probe at step 2 of the `architecture` skill, after the frame and **before** brainstorming spends effort
designing a change whose cost is unmeasured. Report it in three lines:

```
Radius:  <N files, M layers> - <symbols measured>
Braid:   adds | removes | neutral - <what is braided with what>
Cell:    <cell> - <mandated move>
```

Then take the cell's move. On any STOP cell, present 2 or 3 concrete options with their costs and wait. This is the same
weight as the design-approval gate, not an advisory note.

If the probe is expensive to run, that is itself a signal: a change whose blast radius cannot be measured in a few
`findReferences` calls is not a change anyone can size by reading the sentence.

**At review time** the same two axes are measured against the **frame**, not the plan. The plan is what grew, so it
cannot be the yardstick. Two things change once the code exists:

- **Radius is a report, never blocking.** The cost is sunk. The useful output is a staging proposal and the question of
  whether the probe was run at all.
- **Braid is still actionable**, and this is the last gate that can see it: it breaks no import rule, sits in an
  expected file and passes lint. After merge, only the people paying for it will notice.

Attribute honestly: a large radius usually measures complecting the author **inherited**. Saying so is the difference
between a finding that gets fixed and one that teaches the next author to keep the number quiet.
