# Rules

The rules the author proves a proposal against and the verifier checks it against. They add to `AGENTS.md`,
`docs/code/style.md` and `docs/code/placement.md`. Where a style rule blocks a shape whose steps read clearer,
simplicity wins, but it never licenses a change of form. Where `AGENTS.md` names a tool for a job, such as
`createAsyncTaskPool` or `createSharedRun`, that tool wins over any rule here.

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

- **Speculation.** An option nothing passes, a generic parameter with one use, an interface with one implementation and
  no fake, an extension point for a case nobody asked for. A working capability is not speculation (§ What goes to the
  owner), and neither is a dispose, reset or clear with everything it stops, such as the abort it sends to work in
  flight.
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
- An optional parameter with a production default that only tests pass is fine, even when a scout asks to drop it.

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
- Moving a step a microtask later, or behind another listener, changes behaviour. It is fine only when no caller `LSP`
  finds relies on the order. Say so in the commit, and a spec that pins an incidental microtask count may then change.
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
  is what it shows. A defect only a contrived action reaches is left and named in the report.

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

Cite a shape the owner accepted earlier in this run as the precedent for the same shape in another module.

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
| "No caller uses this pause or retry, so delete it"             | A working capability goes only with the owner's yes. A reset, dispose or clear always stays. |
| "An arrow reads shorter here"                                  | Form alone is not simplicity. Keep the style.                                                |
| "This matches a rule, so I apply it"                           | A rule names a move. Keep it only when the module reads better after it.                     |
| "Should I fix this bug?"                                       | A real bug with a small local fix is fixed, not asked about.                                 |
