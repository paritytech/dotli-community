# Parameters that are only valid together

A developer writes or reviews a factory or function that takes two parameters which only make sense as a pair. One is
nullable. The other, often a callback, is used only when the first is set. With the first one null the second is never
used, yet every caller must still pass it, so some caller passes a stand-in, such as a callback that does nothing. The
question is whether to merge the two into one parameter or keep them apart and document how they relate.

## How to resolve

1. Merge the pair into one object parameter that holds both values.
2. Make that object nullable as a whole, where the first value used to be nullable.
3. Let a caller with nothing to pass give null, with no stand-in for the second value.
4. Do not keep the two parameters with a JSDoc line that says when the second one is used.

The owner chose the merge without stating a reason. It makes the invalid mix unwritable, so no caller has to pass a
value that is never used.

## Example

```ts
// Before: the callback is only called when a name is set, yet every caller passes one.
type ReportParams = {
  ownerName: string | null;
  deliver: (result: Result) => void;
};
createReport({ ownerName: null, deliver: () => {} });

// After: the pair is one nullable object.
type ReportParams = {
  owner: { name: string; deliver: (result: Result) => void } | null;
};
createReport({ owner: null });
createReport({ owner: { name: 'settings', deliver: showResult } });
```

## Cases

- A flow factory took the name of the page that opened it, or null, and a callback that hands the result to that page.
  The caller with no opener passed a callback that did nothing. The two became one nullable page parameter. (branch
  complexity-review-fixes)

Status: active
