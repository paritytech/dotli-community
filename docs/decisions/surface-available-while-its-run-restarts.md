# A surface's availability follows a run that restarts

A developer wires a UI surface, such as a panel and the button that opens it, to show only while a background run that
answers its actions has registered for the item on screen. The developer notices the run can end for a transient
reason, such as the core it runs on going down, and starts again on a replacement shortly after. Its registration ends
with it. The question is whether the surface hides until the run registers again, closing a panel the user has open, or
stays available so an action taken in the gap fails.

## How to resolve

1. Turn the surface available once a run has registered for the item on screen.
2. Keep it available until another item shows. A registration that ends because its run restarts does not hide the
   surface or close it while open.
3. Let an action taken in the gap fail with the surface's existing error, such as a not connected error, until the run
   registers again. Add no hiding, waiting state or retry for the gap.

The owner chose to keep the surface available through the restart without stating a reason. The trade-off on offer was
an open panel closing against an action in the gap failing visibly.

## Example

```ts
function createNotesAvailability($shownItem: ReadableAtom<ItemId | null>, runs: RunRegistry) {
  const $available = atom(false);
  $shownItem.subscribe(() => $available.set(false)); // another item shows
  runs.onRegister((itemId) => {
    if (itemId === $shownItem.get()) $available.set(true);
  });
  // A registration ending is not heard here. A post in the gap rejects with the
  // composer's not connected error until the restarted run registers again.
  return { $available };
}
```

Not this:

```ts
// Tracks the live registration, so a core loss hides the button and closes the open panel.
const $available = computed([runs.$registered, $shownItem], (registered, item) => registered.has(item));
```

## Cases

- Chat moved from the product frame to the product worker run, so the chat button and panel show once the worker run
  registers for the shown product. A core loss ends the run and its registration until it reruns on the replacement
  core. The owner chose to keep chat available, with a post in the gap failing with the composer's not connected error,
  over hiding the button and closing the panel. (docs/_plans/worker-chat-design.md, worker-chat)

Status: active
