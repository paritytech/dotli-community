# A slice edits an end-to-end spec

You are building a slice of a change, or writing the brief for the agent that builds it, and the slice edits an
end-to-end spec: a Playwright spec that drives the built app in a real browser. Its setup may even work locally. The
question is whether the slice's checks run that spec beside the cheaper ones.

## How to resolve

1. Update the end-to-end spec's code so it matches the change, like any other test the slice touches.
2. Let typecheck and lint cover it with the rest of the slice.
3. Run only the cheaper checks for the slice: typecheck, lint, unit tests, functional tests and stories.
4. Do not run the end-to-end spec during the slice, even when its setup works locally. A slice brief never tells the
   implementer to run it.

The owner's reason: running the end-to-end spec during a slice is unnecessary and only costs the owner time.

## Example

```text
Slice 3 brief, checks:
  - typecheck, lint
  - unit and functional tests of the touched packages
  - stories of the touched components
  - the checkout end-to-end spec: updated to the new button label, not run
```

Not this: "run the checkout end-to-end spec too if its setup works locally".

## Cases

- In a landing page redesign, a slice brief told the implementer to run the UI smoke spec if its setup ran locally, and
  it did. The owner said running it was unnecessary and wasted their time. (landing-horizon branch, issue
  paritytech/dotli-community#92, slice 2)

Status: active
