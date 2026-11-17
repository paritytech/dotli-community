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

Most complexity is code that serves other code rather than the job. It guards a state that should not be possible,
converts between two shapes of one fact, carries a value through a layer that never reads it, or flags a mode that a
better split would not need. Trimming it line by line leaves its cause in place, and the cause grows it back.

So the pass works in two depths. First find the shape in which that code has no reason to exist, and move the code
there. Then trim what is left. A good pass deletes concepts a reader must hold: a type, a state, a flag, a parameter, a
layer, a guard. Deleting lines while every concept stays is a smaller win, and moving lines while every concept stays is
no win.

Simple code is code whose every step a reader can follow and agree with, not the fewest lines or states. A unit may have
many states, as long as each transition is clear and reasonable.

These rules add to `AGENTS.md`, `docs/code/style.md` and `docs/code/placement.md`. Where a style rule blocks a shape
whose steps read clearer, simplicity wins, but it never licenses a change of form. Where `AGENTS.md` names a tool for a
job, such as `createAsyncTaskPool` or `createSharedRun`, that tool wins over any rule here.

## Taste

Taste is the judgment the rules below cannot make for you. It comes down to a few habits:

- **Be bold where it deletes concepts, and still where it only moves lines.** Rework a module's shape when that makes a
  guard, a flag or a layer disappear. Leave a function alone when the rewrite would only read differently.
- **The code should read like the problem.** A reader learns what the feature does from its names and the order of its
  steps, and meets the plumbing only where they look for it.
- **Count what a reader holds, not what a file holds.** Five named steps in a table read easier than one long body, and
  a switch per question keeps each answer beside its reason. Fewer names can mean more to hold.
- **A seam is not fat.** An optional collaborator only a spec passes, or a read-only method only specs call, is how the
  specs drive the unit. Keep it.
- **Every move answers one question.** What does a reader new to the module gain? When the honest answer is nothing, the
  code stays as it was. Leaving well-shaped code alone is a full result, not a failure to find work.

Moves that matched a rule here and still read worse, kept as calibration rather than rules:

- **Inlining named handlers.** Two states merge, and their shared handlers are left with one caller each. Inlining them
  turns a handler table that read as a map of named steps into a wall of bodies, and copies the shared tail into each.
- **A table of facts for a few fixed cases.** Small functions each switch over one four-member union. Folding them into
  one table of columns makes a reader decode a column and learn that a `null` there means a throw, where each switch
  said it plainly beside its comment.
- **Removing a seam.** Dropping a factory's spec-only collaborator looks like trimming a parameter, but the spec now has
  to reach around the unit.

## The loop

Run it per module, or across the few modules a root cause spans (§ Find the root).

1. **Scout.** Dispatch a fresh agent as the scout (§ The scout) before you read the module yourself. It runs while you
   map.
2. **Map.** Read the module, its specs and its direct callers and callees (`LSP`). Write its job in one sentence. List
   the concepts it makes a reader hold: its types, states, flags, parameters, guards and exported names. Mark each one
   the job needs, and each one that exists only because of another concept or of a choice elsewhere.
3. **Shape.** For each marked concept, find its cause with § Find the root, and the reorganization that removes the
   cause. Then add each of the scout's proposals you did not find yourself. Each proposal names the code it deletes. A
   reorganization that deletes nothing is a change of form and is dropped.
4. **Trim.** List what § Cut what does not pull its weight and the rules after it remove from what is left.
5. **Prove.** Before applying anything, prove each proposal from Shape and Trim, the scout's included:
   - **Cite every fact it rests on.** A caller, a count, "nothing calls it", "it cannot throw", "this guard cannot fire"
     and "another case covers this spec" each come with the file and line you read it from. A fact you did not read is
     unproven. Read it, or drop what rests on it.
   - **Walk the specs.** Walk each spec case that pins a changed path through the new shape, and name each one it cannot
     carry. "The specs still hold" is a claim about cases you walked. A spec cut because another covers it names that
     case, and that case must reach the same path.
   - **Try to break it.** Look for the caller, the re-entrant listener, the contract in a JSDoc or `AGENTS.md`, or the
     spec it would violate. A shared tool that cannot do the job as the module needs it is not the target.
   - **Count the new home.** A proposal that moves code to another module counts what that module holds afterwards. If
     the moved states, events and effects reappear there, it is a relocation and deletes nothing.
   - **Check it against the rules and the owner's list.** A shape that breaks an `AGENTS.md` or `style.md` rule, such as
     a global channel inside one page, is not a target. A proposal that narrows a package's exported API, or changes a
     layer's interface, goes to the owner as a question (§ What goes to the owner), however sure the proof.

   A proposal that fails is fixed or dropped, never kept with a hopeful note. Proving makes a proposal exact. It does
   not make it smaller, so a structural proposal that survives stays as bold as it was. Report each scout proposal you
   drop with the one fact that sank it, so a reader can see it was weighed.

6. **Verify.** Dispatch a fresh agent as the verifier (§ The verifier) with your proven list. Drop each proposal it
   breaks, and send each one it marks as the owner's to the owner. Argue back only with a fact it missed, cited by file
   and line.
7. **Apply, read and check.** Apply the proposals that delete the most incidental code first, one commit each. Read each
   change before and after, as someone new to the module would. Keep it only if you can say in one sentence what is now
   easier to follow. "It is shorter" or "it has fewer names" is not such a sentence. Revert what fails. In each touched
   package, run the unit tests beside lint and typecheck, and `knip` when an export goes. Fix only what they report, and
   do not review again inside this step.
8. **Rate.** A fresh agent that did not write the change rates the module from 1 to 10 in halves, without editing. It
   sees the module before the round as well as after. It says of each change whether it reads better, only different, or
   worse, and a change that is only different counts against the score. It also names the reorganization that would
   delete the most code still left, or says there is none. A module that is tidy line by line in a shape that breeds
   incidental code rates 7 at most. The bar is 9, or 9.5 when the owner raises it. The author's own score does not
   count, nor does a forecast for items not yet applied. Both run high.
9. **Commit,** then start again at Scout. Stop at the bar, or after 3 rounds with the reason it could not be reached.
   Stop early too when what is left is a matter of taste rather than of reading, and say so.

A rater's review is a set of suggestions for the next round, not a list to work through. Weigh each item by the same
reading, and decline one with a line on why. Check it against these rules, `style.md` and the `git log` of its lines
first. A rater can ask for a change of form, or for the reverse of a deliberate commit. Scores are noisy by half a point
between rounds, so a module that sways between two scores is at the lower one.

Run the functional suite before calling the work done, since unit tests pass while a flow across modules breaks.

## The scout

Searching boldly and proving strictly pull against each other in one head: a reviewer who must prove each idea stops
proposing the ones that are hard to prove, and those are often the deepest. So a separate agent searches, and the author
proves.

Dispatch the scout fresh, with only the module's path, this skill's path and the brief below. Give it nothing of your
own reading, so it looks with its own eyes. It edits nothing.

The brief, given as it stands:

> Read the module, its direct callers and callees, and the sections Taste and Find the root of the skill. Find what
> makes the module's incidental code necessary. Look across each boundary: what a caller or callee already decides,
> tracks or guarantees that this module repeats, and which rule the module breaks, such as an effect that sends to its
> own machine. Return at most five reorganizations, the one that deletes the most first. For each, say what moves where,
> which modules it touches, and which concepts it deletes: types, states, events, flags, parameters, guards. Be bold.
> You do not need to prove them, since the author proves each one before applying it. Do not list trims, renames or
> changes inside one function. Return nothing rather than a change of form.

## The verifier

The author who proved a proposal is the worst judge of its proof, since the author already believes it. So a fresh agent
tries to break the list before anything is applied.

Dispatch the verifier fresh, with only the module's path, this skill's path, the author's proven list and the brief
below. It edits nothing.

The brief, given as it stands:

> Read the module, its specs, and its direct callers and callees. For each proposal in the list, try to break it. Walk
> each spec case that pins a path the proposal changes, and check the proposal against `AGENTS.md`, `docs/code/style.md`
> and the skill's section What goes to the owner. Give each proposal one verdict: holds, broken with the spec, caller or
> rule that breaks it cited by file and line, or the owner's, with the one fact that decides it. Judge only what is on
> the list. Do not add proposals, and do not weaken one that holds.

## Find the root

Incidental code has a cause, usually a fact or a decision in the wrong place. Each shape below names the symptom, the
reorganization, and what it deletes. They are the common causes, not a checklist to apply.

- **One fact, two owners.** Two units keep their own copy of a value and code keeps them in step. Give the fact one
  owner and derive the rest (`style.md` § Derive, don't store). The sync code, its invalidation and the bugs where the
  copies drift go.
- **A decision far from its facts.** A unit receives values only to pass them on, or reads another unit's state through
  getters, to decide something the other unit could decide itself. Move the decision to the owner of the facts and let
  it return the outcome. The pass-through parameters and getters go.
- **Checks spread inward.** Inner code guards against input the edge could have refused. Parse once at the boundary into
  a type that cannot be wrong (`style.md` § Parse at the boundary). The inner guards and their specs go.
- **A shape that allows the impossible.** Booleans and optional fields that are only valid together let a value say what
  cannot happen, so readers check for it. Replace them with a union of the real cases (`style.md` § Unions, not enums).
  The checks for the impossible mixes go.
- **Two shapes of one thing.** Adapters convert between near-identical types at each crossing. Keep one shape. The
  adapters and the drift between them go.
- **A layer that only forwards.** A module adds no decision, only renames and passes through. Fold it into its caller or
  its callee. The extra names and the hop go.
- **A mode flag.** A function or a component branches on a flag at several points. Split it into the variants the
  callers really use, or give each variant its own type. The branches go.
- **A special case at every caller.** Callers each handle the same edge before or after a call. The callee owns it, or
  the general path is shaped so the edge needs no branch. The copies go.
- **A lifecycle in loose closures.** Flags and `let`s across closures track where a unit is. One state value holds the
  phase (`style.md` § A lifecycle is one state value), within the limits of § Structure must earn its place. The flag
  checks go.
- **Failures handled at every layer.** Each layer catches, logs and rethrows. One layer decides what happens next and
  reports it, and the others let the error pass. The duplicate handling and doubled reports go.
- **Grouped by kind, not by reason to change.** Types, helpers and constants sit in their own files apart from the flow
  that uses them, so one change touches many files. Regroup by flow (`placement.md`). The cross-imports and barrels that
  only stitch them go.

A root often spans modules. Follow it into the caller or callee that must change too, and scope the run across both,
rather than trimming one side into an awkward fit. A module stuck below the bar usually has its last item there.

A reorganization stays inside the layers and interfaces `AGENTS.md` § Architecture and `placement.md` set. One that
moves code across a package boundary, changes a layer's interface or changes a shared primitive's API goes to the owner
as a proposal, with what it deletes (§ What goes to the owner).

## Structure must earn its place

- Add a mechanism only for the problem it solves. A state machine is earned only when the unit itself runs and waits on
  the work that makes a phase outlive a synchronous call. An await, a remote reply or a timer it set is such work. A
  unit whose transitions are synchronous calls from outside keeps its closures, even when a phase spans someone else's
  wait. So does a synchronous router with latches. `style.md` § A lifecycle is one state value states the same rule.
- A machine whose only async phase a pool or a shared run already owns is not earned. A lazy load whose one wait is the
  load its pool runs is a closure over that pool.
- Revert a migration that fails the rule, unless the plain version is no simpler or a peer depends on the machine. Then
  keep it and say why in the commit.
- Queues, callers waiting on one job, in-flight flags, holder counts, retries and concurrency limits use the `AGENTS.md`
  tools, never a hand-rolled list in a machine's state.
- An invariant is not a caller's knob. When a parameter lets a caller break it, such as a pool of any size where one at
  a time is required, the module builds the thing itself and takes only the safe part.
- Use the shared or the platform primitive over hand-rolled machinery, such as a framework's lazy component or a
  standard parse check.

## Cut what does not pull its weight

Cut these without ceremony. Each is code a reader pays for and the job does not need.

- **Speculation.** An option nothing passes, a generic parameter with one use, an interface with one implementation, an
  extension point for a case nobody asked for. A working capability is not speculation (§ What goes to the owner), and
  neither is a dispose, reset or clear with everything it stops, such as the abort it sends to work in flight.
- **Indirection that adds nothing,** such as a type that only renames, a re-export that only shortens a path, or a
  wrapper that only forwards. A name stays where it saves the reader working out a block, or where it lets a table or a
  sequence read as named steps. One caller is no reason by itself to fold a name away. Metrics, the module reporter and
  the names `style.md` keeps stay too. A module with one caller and no purpose of its own folds into that caller.
- **A guard that cannot fire,** proven from types or the documented contract of every producer. The proof covers
  re-entrant listeners and other modules. A guard that holds a contract across modules stays, and so does one you could
  not prove.
- **Cases that branch one by one over facts that belong together,** which become one table of data (`style.md` §
  Per-member facts in one table). A table pays when its rows are data a reader scans or adds to. Where each function
  asks its own question of a few fixed cases, a switch per function keeps each answer beside its reason. Twin steps
  merge only when the merged step needs no mode flag, since a helper with two modes reads worse than two helpers.
- **Code with another purpose,** such as mapping, formatting or store reads, which moves to a module of its own, and its
  importers follow. Input cleaning moves to the trust boundary that parses the input.
- **Members of a wire, event or message type that nothing sends.** Grep for the sender, not the name, which a metric can
  share.
- **A failure reported twice.** The layer that decides what happens next reports it, an environment failure as
  `report.expected`.
- **A comment that restates the code, or justifies it by a story that can no longer happen.** Delete the first and
  reword the second to the real reason. Check every "never throws" or "never rejects" against the code.
- **A spec that tests nothing the user or caller relies on.** That covers one that repeats a branch another case covers
  or retests a shared helper or a third party. A check of copy, markup or DOM order goes, and so does a call count the
  case is not about. How many items the user sees, when that is the behaviour, is asserted by role. A call count or
  report the case is about stays, and so does the only test of a failure path, a race or a recovery (`style.md` §
  Tests). A spec that pins a loss is a bug to fix, not a contract.

## Inside a machine

States and events:

- A flow whose steps hide in one phase (a step string, a few `let`s, a chain of awaits) is nested. Its steps become
  states, never a helper that walks them on the side. A state that only waits for an event sent in the same transition
  is not a state.
- Independent steps that run side by side join into one settled event, such as one `Promise.allSettled`, not a waiting
  state for each mix of finished steps. Two awaits of one step need no pool.
- A per-item record that is only pending, then settled, such as the reply to each request the unit sent, is a deferred
  in a map in the parent's state, not a nested machine. Callers who all wait on one shared job are not such records.
  They share a pool of one.
- One event has one meaning. When a handler tests the state's kind or a payload flag to branch, split the event or the
  handler so the table picks. States or events that differ only in a name, or in a handler nothing reaches, merge.
- Every way a unit ends, a failure included, goes through one path, so the end screen and the report have one call site
  each.
- States, events and effects never share a name.

Values:

- In a unit with a machine, a value a decision reads lives in the state. A closure `let` or a map beside the state is
  out, and so is a flag. Only facts that are not phases, such as a config, sit beside the state.
- An event carries the facts read at its source, such as the time a step ended. A handler reads no store and no clock.
  It never reads another machine either.
- A fact needed to judge a value travels with that value. A report carries whether its source is still live, and a
  result carries the identity it was for. A late result for a superseded run then finds nothing to apply to.
- Store one fact once and derive the rest, and never copy another unit's state. A value that listeners must see at every
  step, one passing through inside a transition included, stays stored, since a derived value hands a nested listener
  only the latest.
- Hold the smallest handle the stop needs. A timer keeps its handle in the state. An `AbortController` is only for a
  listener or a call that takes its signal.
- A stored callback that only reports becomes an event or an effect. It stays when callers rely on the synchronous order
  it runs in, such as a close that ends every call before it returns.

Side effects:

- **Transition work** is what the next state owns, and it starts in the handler (`style.md` § A lifecycle is one state
  value). That is async work whose result comes back as an event (`update(promise)`), and a timer or listener whose
  handle the next state holds.
- **A side effect** is anything the machine never hears back from, and it runs in the effect runner. For example:
  - settling a caller's promise
  - clearing a timer or removing a listener
  - closing a channel or posting a message
  - moving focus or writing a store
  - logging and reporting
- Never move an effect into a handler to save lines or bytes, even one that only forwards to one call. The runner runs
  effects in order after the state is published, and isolates a throw. In a handler, a log can run before its step and a
  throw can skip a later stop. The style rule that inlines a forwarding function does not reach effect cases.
- Nothing the logic starts refers back to the machine. An effect never sends to its own machine, and a callback or timer
  sends through the `update` it was given.
- A shared primitive's API, such as the state machine factory's, is fixed. Work within it.

## Any code

- The same split holds outside machines. The code that decides returns what happens next, and one place acts on it.
- A caller that waits for work to settle waits on the work's owner (`await()`), never by polling a status or on a
  promise kept beside it.
- A listener that can call back in hears a change only once the change is whole, so it never sees half a step.
- A resource is owned by the signal of what holds it, so it ends when its holder leaves and no race orphans it.
- Parameters are only what the unit reads, typed from their owner and grouped by owner (`style.md` § Pass collaborators
  whole, grouped by owner). When the unit only hands a parameter to a collaborator it builds, take the collaborator
  instead. No grab bag of ports.
- A function returns one kind, never `boolean | Error`. When many cases lead to one value, that value is the default,
  not a branch each. A union by phase or outcome replaces flags.
- When every caller pairs two steps, the callee does both. Don't repeat a check or a read the callee already makes. Lean
  on its refusal or its result.
- An optional parameter with a production default that only tests pass is fine, even when a rater asks to drop it.

## Compatibility paths

For a path whose producer may be gone, find when the producer stopped with `git log -S` and the release tags. Then ask
whether it can still meet current code:

- **Never shipped,** as when no release wrote the data or sent the message. Remove it.
- **Gone,** as for a peer deployed with it and fetched fresh on each load, or a pairing only a tab open for a month
  reaches. Remove it with everything that serves only it. Its options and metrics go, and its specs and comments too.
- **Still there,** as for data persisted on a returning visitor's device, or a worker installed until they come back.
  Keep it and say how long it must stay. Direction matters: an old page meeting a new worker is another case than a new
  page meeting an old installed worker.
- **Below the browser floor,** a fallback for an API that ES2022 and Safari 17.4 have (`AGENTS.md` § Project). Remove it
  with everything that serves only it.
- **Two purposes,** when the path also covers a live case. Keep the behaviour and reword the reason.

During an unreleased refactor, add no shim for the code it replaces. When a path's fate turns on a policy fact, such as
how long a visitor's data is kept, ask the owner with that fact.

## Boot size

Never trade readability for bytes. A smaller module must read at least as clearly. Win size by moving an off-path
feature into its own chunk, not by trimming the shape of code that must load, and report any change in when a view first
shows. When a budget is still missed and the code is earned, ask the owner about the budget instead of undoing earned
structure.

## Behaviour

- Keep the public contract and what users and callers rely on. A spec changes only where it reaches into removed
  internals or falls under the spec rule above, never to hide a change.
- Moving a step a microtask later, or behind another listener, changes behaviour. It is fine only when `LSP` shows no
  caller relies on the order. Say so in the commit, and a spec that pins an incidental microtask count may then change.
- Name every accepted behaviour change in the commit.
- Fix a real bug found on the way, with a spec that fails first. These are bugs, not trade-offs:
  - a leak, or a set or map that grows with no bound
  - a wait that never settles, or a throw that skips the cleanup after it
  - a wrong, lost or doubled report, or a misleading log value
  - a lost record or lost work, such as an event dropped in a state that ignores it
  - a stale or made-up value on screen, or a false success message
  - a result applied for a superseded run, or a read made stale by an await
  - a callback that re-enters a transition and reads half a step
  - a backoff or counter reset on the wrong boundary
  - a Retry or Cancel that leads to the wrong next step
  - a key so narrow that two owners collide, or an input the trust boundary lets through
  - a regression the simplification caused
- Judge a suspected bug by its usual case. A status that looks wrong on a rare path is right when its usual cause really
  is what it shows. A defect only a contrived action reaches is left and recorded.

## What goes to the owner

A working capability is anything a caller can call to act on running work, or a cache, that works as named. A pause, a
stop, a retry and a dispose are such. One that does not work as named is a bug, and its fix makes it work. It never
removes it. A reset, dispose or clear stays even when nothing calls it, and is never asked about (`AGENTS.md` § Code
style).

Decide alone, act, and name it in the commit:

- a reorganization inside one package that keeps every layer's interface and deletes incidental code
- a bug of the kinds above with a small local fix
- a report's shape, which `AGENTS.md` fixes
- an export only its own spec uses, unless it is a working capability
- a type with no importer, or a helper only removed code used
- an option nothing passes, specs included, unless it is a working capability
- a branch dead behind a documented "never rejects" contract

Ask, with the one fact that decides it, what it deletes and a recommendation:

- a reorganization across a package boundary, or one that changes a layer's interface
- removing a working capability that has no caller yet (`AGENTS.md` § Code style)
- what users see or read, such as copy or how often a status line changes
- a compatibility policy for returning visitors
- a size or performance budget
- a change to a shared primitive's API

Cite a shape the owner accepted in one module as the precedent for the same shape elsewhere.

## Red flags

| Thought                                                        | Reality                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| "I'll tidy each function and the module will follow"           | Find what makes the incidental code necessary first. Trimming leaves the cause in place.     |
| "This reorganization is cleaner"                               | Name the code it deletes. If it deletes nothing, it is a change of form.                     |
| "The fix belongs in the caller, but this module is my scope"   | Follow the root into the caller and widen the scope, or propose it to the owner.             |
| "Everything with phases should be a state machine"             | Only a phase the unit itself waits out earns one.                                            |
| "Every used value is in the state, so the caller queue is too" | Queues and in-flight work use the pool or the shared run.                                    |
| "This effect only forwards one call, so inline it"             | Every side effect stays an effect. Bytes never justify the move.                             |
| "This changes behaviour, so I list it as a trade-off"          | If it leaks, hangs, misreports, loses or misleads, it is a bug.                              |
| "Keep the old path, just in case"                              | Check when its producer stopped and whether it can meet you.                                 |
| "Someone may need this option later"                           | Speculation goes. A working capability is the exception, and the owner decides it.           |
| "The specs still hold"                                         | Only for the cases you walked. Name them.                                                    |
| "Nothing calls this"                                           | Cite the search you ran. A spec, a fake or another package may call it.                      |
| "I scored it 9.5"                                              | Only a fresh rater's score counts.                                                           |
| "No caller uses this pause or retry, so delete it"             | A working capability goes only with the owner's yes. A reset, dispose or clear always stays. |
| "An arrow reads shorter here"                                  | Form alone is not simplicity. Keep the style.                                                |
| "This matches a rule, so I apply it"                           | A rule names a move. Keep it only when the module reads better after it.                     |
| "The rater listed it, so I do it"                              | A rater suggests. Weigh each item by reading, and decline with a reason.                     |
| "Should I fix this bug?"                                       | A real bug with a small local fix is fixed, not asked about.                                 |
