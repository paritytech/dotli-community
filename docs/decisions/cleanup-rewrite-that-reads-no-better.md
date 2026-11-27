# A cleanup rewrite that reads no better

A developer runs a simplification pass or a review fix over code that already works, by hand or through the
`reduce-complexity` skill. A rule from the style guide or the pass matches the shape in front of them, or a rater lists
it as an item to fix. It may be a helper used only once, or a few functions that each branch over the same union. It may
be an optional parameter that only the spec passes, or a unit's states that mirror another unit's states because only
that other unit moves it between them. It may be one event that carries a collaborator's whole state, which handlers
then switch on, where one event per meaning could be split out at the subscription. It may be a guard that keeps a
short-lived UI's timer from running while there is nothing for it to update, which a few lines fewer could drop at the
price of idle work. The rewrite the rule describes is possible, and the question is whether a match is reason enough to
make it. When a pass has already made code read worse, a second question is how to correct the pass.

## How to resolve

1. Treat the rule as a move, not a goal. A match only says the move is worth trying.
2. Picture the rewrite, or write it, and read it beside the code it replaces as someone new to the module would.
3. Say in one line what a reader gains, such as a hop they no longer follow or one edit per member where there were
   several. Shorter, or fewer names, is not such a line.
4. Look at what the rewrite adds to get there. A placeholder value with a check to stand in for a case the old code
   handled directly is a cost. So is a multi-line body moved into a place that used to read as a list of names. So is
   a dropped optional collaborator with a production default that only the spec passes, since it is the seam the spec
   drives the unit through, and the spec then has to reach around the unit. So is folding a unit's named states into
   one state under a vaguer name, so the unit no longer says which phase it is in. So is dropping a guard the change's
   design names, such as a timer that runs only while there is something to update, since the code then does work the
   old code skipped, even when that work is small and touches nothing on screen.
5. Make the rewrite only when the gain is real and outweighs what it adds. When it reads the same or worse, leave the
   code as it is, or revert it. Leaving the code as it is counts as a full result, not as failing to find work.
6. A narrow style fix in the same code, such as an `===` test on a union member turned into a `switch` over every
   member, still applies when the larger rewrite is left out.
7. Treat a rater's items as suggestions. The rater sees the code before and after, and a change that only reads
   different counts against it. Weigh each item by the same reading, and decline one with a line on why.
8. When a pass made code read worse, correct the pass by giving it judgment, such as the read-before-and-after check and
   contrasting shapes that show a matched move reading worse. Do not add a new strict rule against the move.

A rule matching the shape is not the gain. The owner called such a rewrite a random choice, and said another looked
worse than before. Both were undone, and so was a dropped test seam, which the repo already allows. A merge of a unit's
two phases into one left the owner unable to tell what the new state meant, and it was undone too. The owner wants the
fixer to show taste in general, and does not want a stricter rule in its place, since an agent over-applies a strict
rule the same way the rule that caused the damage was over-applied, so a new one would only move the problem.

## Example

A machine's handler row where each event names its step:

```ts
saving: {
  saved: landSave,
  saveFailed: landFailedSave,
},
```

Inlining the two steps only because each is used once turns the row into bodies a reader must work through to see which
event does what, with any shared tail copied into each. Leave it.

Three small functions over one union, each an exhaustive `switch` that answers its own question, one of them throwing for
a member that has no answer:

```ts
function toVerdict(answer: Answer): Verdict {
  switch (answer) {
    case 'yes':
      return 'Accept';
    case 'no':
      return 'Reject';
    case 'skipped':
      throw new Error(ERRORS.NO_ANSWER);
  }
}
```

A table of facts per member would need `verdict: null` for `'skipped'` and a null check in the function to throw again.
That reads worse than the `switch`. Leave it.

A factory whose spec hands it a fake queue and notifier:

```ts
export function createGreeter({
  enqueue = enqueueDialog,
  notify = showToast,
}: GreeterOptions = {}): Greeter {
  // ...
}
```

Dropping the two options because only the spec passes them leaves the spec with no way in short of module mocks. Leave
them.

A session's states, where only its owner moves it from loading to live:

```ts
type SessionState =
  | { kind: 'loading' }
  | { kind: 'live' }
  | { kind: 'failed'; error: Error };
```

Folding `loading` and `live` into one `active` state, with the owner keeping the readiness instead, leaves a reader
asking what `active` means and where the two phases went. Leave them.

A machine that sends each change of a collaborator's store as one event, where a handler tests the payload for one
member:

```ts
feed.subscribe((status) => send({ kind: 'feedMoved', status }));

// Before: one member tested with ===
feedMoved(state, event) {
  if (event.status.kind === 'closed') return finish(state);
  return state;
},

// After: the same event, the test turned into a switch over every member
feedMoved(state, event) {
  switch (event.status.kind) {
    case 'closed':
      return finish(state);
    case 'open':
    case 'paused':
      return state;
  }
},
```

Splitting `feedMoved` into `feedOpened`, `feedPaused` and `feedClosed` at the subscription adds event kinds and moves
the mapping into the subscription. Keep the one event and make only the style fix.

An open panel whose clock ticks only while one of its items is busy:

```ts
const anyBusy = createMemo(() => items().some((item) => item.busy));

createEffect(anyBusy, (busy) => {
  if (!busy) return;
  const timer = setInterval(tick, 250);
  return () => clearInterval(timer);
});
```

Dropping the memo and the guard so the clock always ticks while the panel is open saves a few lines but wakes the page
four times a second with nothing to update. Leave the guard.

## Cases

- Merging two states of a machine left two named handlers, a few lines each, that end a read on success and on
  failure, used only by the merged state. They were inlined into its handler row and restored as named handlers. (PR
  #484)
- Four small predicate and mapping functions over a four-member answer union, each an exhaustive `switch`, became one
  record of facts per member with a null fact and a null check for the member that throws. The switches were restored.
  (PR #484)
- A factory's two optional collaborators, where its dialogs queue and how it notifies, each with a production default
  that only its spec passes, were removed in a simplification round. The spec no longer typechecked, and they were
  restored. (PR #484)
- After the three cases above, the owner found the round's results worse. The skill gained a check that reads each
  change before and after, and its rater now compares the two and gives items the fixer may decline. A section of
  contrasting shapes shows matched moves that read worse. No new strict rule was added.
  (feat/browser-device-permissions, PR 484)
- A review fix found a worker lifecycle's syncing and ready states mirroring the worker's own phases, since only the
  worker marked it ready. It merged them into one running state and moved the readiness to the worker. The lifecycle's
  ready query and mark-ready call went with them. The owner could not tell what
  running meant, asked why syncing and ready went, and had it reverted. (branch complexity-review-fixes, fbfefce2c
  reverted by 0fdd2ed18)
- A review fix found a machine sending each change of a collaborator's state store as one event carrying that state.
  One handler switched on it to relay into a nested flow, and another tested it for one value with `===`. Splitting it
  at the subscription into one event per meaning would drop the relay hop and the test, but add event kinds and move
  the mapping switch to the subscription. The owner kept the one event, without a stated reason, and had only the `===`
  test turned into an exhaustive `switch`. (branch complexity-review-fixes, design goal item 7)
- A simplification round proposed dropping the gate that keeps an open popover's 250 ms clock, in a panel listing
  network chains, idle unless a chain is in use. The change's design names the gate. Dropping it would remove one memo,
  one guard and the effect keyed on it, for four idle wake-ups a second with no DOM writes. The owner kept the gate,
  choosing the recommended option without a stated reason, over dropping it or measuring idle CPU first.
  (feat/network-chain-indicators)
- A simplification round proposed binding a shared reader to one network at construction instead of taking it per
  read. One entry would have needed a placeholder reader for a network that failed to parse, and another a module-scope
  getter for a network not yet settled. The owner kept the network per read. The rule it rests on is
  [per-network-input-a-low-level-package-may-not-load](per-network-input-a-low-level-package-may-not-load.md).
  (reduce/stack-reader-stored-copy, reduce-complexity round, proposal O2)

Status: active
