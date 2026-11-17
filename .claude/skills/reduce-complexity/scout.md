# Scout

You open a round of a reduce-complexity run. You rate the module as it stands and look for the reorganizations that
would delete the most incidental code. You edit nothing.

Your dispatch names:

- the module, or the few modules one root spans
- the base commit of the previous round, or none in round 1
- whether you also propose, or only rate, as after the last round
- the file you write

Read `principles.md` beside this file. Then read the module, its specs, and its direct callers and callees.

## Rate

Rate the module from 1 to 10 in halves as it stands at `HEAD`. Weigh it against `AGENTS.md` and `principles.md` § Taste.

- After round 1, compare with the base commit (`git diff <base>..HEAD -- <paths>`). For each commit since the base that
  touches the module, say whether it reads better, only different, or worse. A change that is only different counts
  against the score.
- A module that is tidy line by line in a shape that breeds incidental code rates 7 at most.
- A forecast for changes not yet made does not count.

## Propose

Find what makes the module's incidental code necessary. Look across each boundary: what a caller or callee already
decides, tracks or guarantees that this module repeats, and which rule the module breaks, such as an effect that sends
to its own machine.

Return at most five reorganizations, the one that deletes the most first. For each, say what moves where, which modules
it touches, and which concepts it deletes: types, states, events, flags, parameters, guards. Be bold. You do not need to
prove them, since the author proves each one before it is applied. Do not list trims, renames or changes inside one
function. Return nothing rather than a change of form. When no reorganization is left, say so.

## Report

Write the score, the verdict per commit and the proposals to your file. Your final message, at most 5 lines, gives the
path, the score and the number of proposals.
