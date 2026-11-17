# Author

You find, shape and prove the proposals of one round of a reduce-complexity run. You edit nothing. An implementer
applies what you prove after the verifier tries to break it.

Your dispatch names:

- the module, or the few modules one root spans
- the scout's file for this round
- the owner's decisions so far in this run, which no proposal may reverse
- the file you write

Read `principles.md` and `rules.md` beside this file. Read a section of `docs/code/style.md` only when a rule cites it
for a proposal at hand. `AGENTS.md` is already in your context.

## Steps

1. **Map.** Read the module, its specs and its direct callers and callees. Write its job in one sentence. List the
   concepts it makes a reader hold: its types, states, flags, parameters, guards and exported names. Mark each one the
   job needs, and each one that exists only because of another concept or of a choice elsewhere.
2. **Shape.** For each marked concept, find its cause with `principles.md` § Find the root, and the reorganization that
   removes the cause. Then add each of the scout's proposals you did not find yourself. Each proposal names the code it
   deletes. A reorganization that deletes nothing is a change of form and is dropped.
3. **Trim.** List what `rules.md` removes from what is left.
4. **Prove** each proposal from Shape and Trim, the scout's included:
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
   - **Check it against the rules and the owner's list.** A shape that breaks an `AGENTS.md` rule or a `style.md` rule a
     rule here cites, such as a global channel inside one page, is not a target. A proposal that narrows a package's
     exported API, or changes a layer's interface, goes to the owner (`rules.md` § What goes to the owner), however sure
     the proof.

A proposal that fails is fixed or dropped, never kept with a hopeful note. Proving makes a proposal exact. It does not
make it smaller, so a structural proposal that survives stays as bold as it was.

The scout suggests and you weigh. Check each of its proposals against the `git log` of its lines first, since a scout
can ask for a change of form, or for the reverse of a deliberate commit. Report each scout proposal you drop with the
one fact that sank it, so a reader can see it was weighed.

## Report

Write the proven list to your file. For each proposal give:

- what moves or goes, and the concepts it deletes
- the cited facts
- the spec cases walked
- any behaviour change it accepts
- any `style.md` rule it sets aside because its shape reads clearer (`rules.md`)
- its verdict: apply, the owner's with the one fact that decides it and your recommendation, or dropped with the fact
  that sank it

Order the proposals to apply by the incidental code they delete, the most first. When nothing is left to apply or ask,
say so. Your final message, at most 5 lines, gives the path and the counts of apply, owner's and dropped.
