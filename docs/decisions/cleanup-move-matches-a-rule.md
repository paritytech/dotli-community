# A cleanup finds a shape that matches one of its rules

You are running a simplification pass, by hand or through the `reducing-complexity` skill. A shape in the module matches
one of the pass's rules, such as a helper left with one caller or several switches over one union. Or a rater lists it
as an item to fix. Do you apply the rule's move because the pattern matches, or only when the code reads better after it?
And when a pass has already made code read worse, how do you correct the pass?

## How to resolve

1. Treat the rule as a move, not a goal. A match only says the move is worth trying.
2. Apply it, then read the code before and after as someone new to the module would.
3. Keep the change only if you can say in one sentence what is now easier to follow. Shorter, or fewer names, is not
   such a sentence. Revert it otherwise.
4. Leaving the code as it is counts as a full result, not as failing to find work.
5. Treat a rater's items as suggestions. The rater sees the code before and after, and a change that only reads
   different counts against it. Weigh each item by the same reading, and decline one with a line on why.
6. When a pass made code read worse, correct the pass by giving it judgment, such as the read-before-and-after check and
   contrasting shapes that show a matched move reading worse. Do not add a new strict rule against the move.

The owner's reason: the owner wants the fixer to have taste in general. A strict rule gets overused by the fixer just as
the rule that caused the damage was, so a new one would only move the problem.

## Example

The pass sees two handlers with one caller each after a state merge, and its rule says to fold a name with one caller:

```ts
// Kept: the table reads as a map of named steps, and both share a tail
const handlers = {
  loaded: (state, event) => settle(state, event.items, event.at),
  failed: (state, event) => settle(state, [], event.at),
};

// Reverted: inlined bodies, the shared tail copied into each
const handlers = {
  loaded: (state, event) => ({ ...state, kind: 'ready', items: event.items, seenAt: event.at }),
  failed: (state, event) => ({ ...state, kind: 'ready', items: [], seenAt: event.at }),
};
```

What a reader new to the module gains from the second form is nothing, so the first stays.

## Cases

- A round of the pass inlined two named state-machine handlers left with one caller each. It folded four small switches
  over one four-member union into a record of facts with columns. It also dropped a factory's optional collaborator
  that only its spec passed. The owner found the results worse. The skill gained a check that reads each change before and
  after, and its rater now compares the two and gives items the fixer may decline. A section of contrasting shapes
  shows matched moves that read worse. No new strict rule was added.
  (feat/browser-device-permissions, PR 484)

Status: active
