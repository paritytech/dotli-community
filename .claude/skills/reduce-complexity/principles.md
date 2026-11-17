# Principles

What simple code is, the taste that judges a move, and where incidental code comes from. The scout and the author of a
reduce-complexity round read this file.

Most complexity is code that serves other code rather than the job. It guards a state that should not be possible,
converts between two shapes of one fact, carries a value through a layer that never reads it, or flags a mode that a
better split would not need. Trimming it line by line leaves its cause in place, and the cause grows it back.

So the pass works in two depths. First find the shape in which that code has no reason to exist, and move the code
there. Then trim what is left. A good pass deletes concepts a reader must hold: a type, a state, a flag, a parameter, a
layer, a guard. Deleting lines while every concept stays is a smaller win, and moving lines while every concept stays is
no win.

Simple code is code whose every step a reader can follow and agree with, not the fewest lines or states. A unit may have
many states, as long as each transition is clear and reasonable.

## Taste

Taste is the judgment the rules in `rules.md` cannot make for you. It comes down to a few habits:

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
  phase (`style.md` § A lifecycle is one state value), within the limits of `rules.md` § Structure must earn its place.
  The flag checks go.
- **Failures handled at every layer.** Each layer catches, logs and rethrows. One layer decides what happens next and
  reports it, and the others let the error pass. The duplicate handling and doubled reports go.
- **Grouped by kind, not by reason to change.** Types, helpers and constants sit in their own files apart from the flow
  that uses them, so one change touches many files. Regroup by flow (`placement.md`). The cross-imports and barrels that
  only stitch them go.

A root often spans modules. Follow it into the caller or callee that must change too, and scope the run across both,
rather than trimming one side into an awkward fit. A module stuck below the bar usually has its last item there.

A reorganization stays inside the layers and interfaces `AGENTS.md` § Architecture and `placement.md` set. One that
moves code across a package boundary, changes a layer's interface or changes a shared primitive's API goes to the owner
as a proposal, with what it deletes (`rules.md` § What goes to the owner).
