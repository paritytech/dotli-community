# A cleanup rewrite that reads no better

A developer runs a simplification pass over code that already works. A rule from the style guide or the
reducing-complexity skill matches the shape in front of them, such as a helper used only once, a few functions that
each branch over the same union, or an optional parameter that only the spec passes. The rewrite the rule describes is
possible, and the question is whether a match is reason enough to make it.

## How to resolve

1. Picture the rewrite, or write it, and read it beside the code it replaces.
2. Say in one line what a reader gains, such as a hop they no longer follow or one edit per member where there were
   several.
3. Look at what the rewrite adds to get there. A placeholder value with a check to stand in for a case the old code
   handled directly is a cost. So is a multi-line body moved into a place that used to read as a list of names. So is
   a dropped optional collaborator with a production default that only the spec passes, since it is the seam the spec
   drives the unit through, and the spec then has to reach around the unit.
4. Make the rewrite only when the gain is real and outweighs what it adds. When it reads the same or worse, leave the
   code as it is.

A rule matching the shape is not the gain. The owner called such a rewrite a random choice, and said the other one
looked worse than before. Both were undone, and so was a dropped test seam, which the repo already allows. The owner
wants a cleanup to show taste in general, and does not want a stricter rule in its place, since an agent over-applies a
strict rule the same way.

## Example

A machine's handler row where each event names its step:

```ts
saving: {
  saved: landSave,
  saveFailed: landFailedSave,
},
```

Inlining the two steps only because each is used once turns the row into bodies a reader must work through to see which
event does what. Leave it.

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

Status: active
