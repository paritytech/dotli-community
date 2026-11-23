# A light-dismiss popover closes when it should not

A developer works with a popover on the shared floating layer in light-dismiss mode and notices it closes when the user
did not leave it:

- The layer closes the popover on every window `blur`, because a press inside an embedded cross-origin iframe reaches
  the page only as a blur. It also closes when the browser takes focus with its own UI, such as while the page reloads
  an embedded frame, or when the user switches to another app, though focus is still on the element inside the popover.
- The popover is anchored to a control that cannot be its invoker, such as a text field or a bar around one, and the
  browser's light dismiss counts a press on that control as outside. The caller may also map every close to a state that
  lasts, such as one that holds until the user types, so the press hides the popover for longer than one click.

The question is which of these should close the popover. A second question is whether the fix belongs in the shared
layer or with the one feature that is hurt, such as by reopening the popover after such a close.

## How to resolve

1. Fix it in the shared floating layer, not with handling in the primitive or the feature that is hurt. Do not reopen
   the popover after a close it should not have had.
2. On a window `blur`, read the document's active element, and close the popover only when that element is an iframe
   outside the popover, which means the press went into an embedded app. Leave it open for any other blur, such as one
   to the browser's own UI or to another app, as a native light-dismiss popover stays open.
3. Treat a press on an anchor that cannot be the invoker as a press inside: it leaves the popover open. Give the layer an
   option, as [existing-unit-needs-a-variant-or-another-value](existing-unit-needs-a-variant-or-another-value.md) says,
   under which it runs its own closes instead of the browser's light dismiss:
   - a press outside both the anchor and the layer
   - Escape
   - focus leaving both the anchor and the layer
   - the window blur into an embedded frame, as step 2 says
4. Let a primitive anchored to such a control use the option. Users whose anchor is the invoker keep light dismiss.

The owner chose to close only on a blur into the embedded app, and that a press on the anchor keeps the popover open,
without stating more of a reason. The options chosen match how a native light-dismiss popover behaves, and fix the close
where it happens, in the shared layer.

## Example

```ts
// Inside the layer: only a press into an embedded frame outside the layer closes on blur.
window.addEventListener('blur', () => {
  const active = document.activeElement;
  if (active instanceof HTMLIFrameElement && !layerElement.contains(active)) {
    closeLayer();
  }
});
```

```tsx
// The list drops from a field, which cannot invoke a popover, so it asks the layer to run its own closes.
<Floating anchor={queryField} selfDismiss open={open()} onClose={hideHints}>
  <HintList items={hints()} />
</Floating>;

// Inside Floating, under the option.
const isInside = (target: Node) => props.anchor.contains(target) || layer.contains(target);
onPressDown((event) => {
  if (!isInside(event.target as Node)) close();
});
onEscape(close);
onFocusLeaves([props.anchor, layer], close);
onBlurIntoFrame(close);
```

Not this:

```tsx
window.addEventListener('blur', () => closeLayer()); // every blur closes

// The layer light-dismisses on a press in the field, and the caller reopens it.
<Floating anchor={queryField} open={open()} onClose={(cause) => (cause.onAnchor ? reopen() : hideHints())}>
  <HintList items={hints()} />
</Floating>
```

## Cases

- A shared UI package's floating layer closed a popover on every window blur, so a browser taking focus while the page
  reloaded an embedded frame closed it too. It now closes only when the blur went into an iframe outside the popover.
  (PR #484, branch `feat/browser-device-permissions`)
- A list primitive built on the shared floating layer in light-dismiss mode was anchored to a text field and the bar
  around it, and its caller held every close until the user typed, so a press in the field hid the list. Offered to
  accept it, to give the layer an option that runs its own closes, or to reopen after an anchor press, the owner chose
  that the press keeps the list open through the layer's option. (architecture change "Action group More: Listbox on
  wide screens", docs/\_plans/more-listbox-design.md, branch `feat/landing-horizon`)

Status: active
