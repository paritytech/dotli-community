# A play asserts a number shown as plain text

A developer writes or trims a component's story file under the stories contract (`docs/code/stories.md`), which says a
kept play asserts the role or the state a user acts on, never the copy, and lint refuses `toHaveTextContent` in story
files. They find a kept play that is the only guard of an edge case about a number the component shows, such as a count
that must keep going past the cap of a list that keeps only the newest items. The number is plain text, with no role,
accessible name or `data-*` attribute that carries it. The question is how the play asserts it:

- read it through another query, such as `getByText`
- give the shipped component an accessible name that carries the number
- move the logic into a module with a unit spec
- keep `toHaveTextContent` behind a lint exception

## How to resolve

1. Confirm the number is the state the play guards, not a label or other copy, and that nothing else asserts it.
2. Leave the shipped component and the logic where they are. Do not add an accessible name or a module only so the play
   can read the number.
3. Keep the `toHaveTextContent` assertion and put a line-level `eslint-disable-next-line no-restricted-properties` on
   it, with a one-line reason that the number is the element's state, not copy.
4. Remove any file-level disable of the same rule, so every other assertion in the file stays checked.

The owner chose the one-line exception: the number is the element's state, not copy, so asserting its text keeps to
what the contract means, and the exception stays on the one line that needs it.

## Example

```tsx
await step('Then the counter counts them all', async () => {
  // eslint-disable-next-line no-restricted-properties -- The counter's number is its state, not copy.
  await waitFor(() => expect(canvas.getByTestId('feed-counter')).toHaveTextContent('600'));
});
```

Not this: a file-level `/* eslint-disable no-restricted-properties */` at the top of the story file, or an
`aria-label` added to the shipped counter only so the play can query by it.

## Cases

- A debug panel's counter badge must keep counting past the cap of its log, which keeps only the newest events, and a
  kept play was the only guard. The owner kept `toHaveTextContent` with a line-level lint exception and a reason, and
  the file-level disable went, over a `getByText` query, an accessible name on the badge or a unit spec. (branch
  `chore/story-contract`, commit 5346a2daa, `docs/_plans/story-contract-design.md`)

Status: active
