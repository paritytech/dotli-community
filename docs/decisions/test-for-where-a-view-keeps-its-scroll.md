# A test for where a view keeps its scroll

A developer builds or reviews a scrolled view that keeps the reader at a place as its content or its size changes, such
as a conversation that stays at the newest message when the panel resizes, when a message grows late, when the user
sends one, and that stops watching its size once it closes. They notice the only way to test it in a story is a play
with heavy browser setup: a hand-built resize observer helper, inline width or margin poked on a surrounding element, or
an element detached and attached again. The stories contract says heavy setup points at a missing seam, and a race
counts as an edge case a play may guard. The question is which of these to do:

- keep the plays
- move the scroll decision into its own module with a unit spec, and keep at most one play for the wiring
- test it not at all

## How to resolve

1. Write no story play for where the view keeps its scroll. Delete any that exist, with the helpers only they use.
2. Extract no module for the scroll decision only so a spec can reach it, and write no unit spec for it. The code stays
   where it is.
3. Keep the file's stories that show a visible state, such as a long conversation, as visual docs without the scroll
   play.
4. Do not let the contract's race reason or its heavy-setup line turn this behaviour into a test. Both apply to
   behaviour worth testing, and this is not.

The owner's reason: keeping the scroll at the bottom does not need a test, and a unit spec for it is overkill. Covering
every behaviour with a test is not a goal.

## Example

```tsx
// Not this: a play per scroll case, each with browser setup.
export const ResizingKeepsReaderAtBottom: Story = {
  args: { ...Long.args },
  play: async ({ canvasElement }) => {
    const observed = installResizeProbe(canvasElement);
    canvasElement.closest<HTMLElement>('[data-drawer]')!.style.width = '320px';
    await observed.settled();
    await expect(isAtBottom(canvasElement)).toBe(true);
  },
};

// Nor a module extracted only for a spec:
// thread/scroll-pin.ts + thread/scroll-pin.spec.ts

// This: the story shows the state and nothing tests the scroll.
export const Long: Story = { args: { messages: longThread } };
```

## Cases

- A chat panel's story file held five plays that kept the reader at the newest message on resize, on a late-growing
  message, on send and that stopped its size watch on close, each with a hand-built resize observer helper, a drawer's
  inline width and margin, or a detached element attached again. The owner had all five and their helpers deleted, with
  no unit spec and no seam extracted, over keeping the plays or moving the logic to a unit-tested module. (branch
  `feat/chat-figma-design`)

Status: active
