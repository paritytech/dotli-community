# A press on its anchor closes a light-dismiss popover

A developer builds a primitive on the shared floating layer in light-dismiss mode and anchors it to a control that
cannot be the popover's invoker, such as a text field or a bar around one. They notice that a press on that control
closes the popover: the browser's light dismiss counts the press as outside, because the control is not the invoker.
The caller may also map every close to a state that lasts, such as one that holds until the user types, so the press
hides the popover for longer than one click. The question is whether a press on the anchor should close it like any
outside press, whether the layer should change how it closes, or whether the popover or its caller should reopen it
after such a close.

## How to resolve

1. Treat a press on the anchor as a press inside: it leaves the popover open.
2. Fix it in the shared floating layer, as an option on it, not with handling in the primitive or its caller.
3. With the option set, the layer runs its own closes instead of the browser's light dismiss:
   - a press outside both the anchor and the layer
   - Escape
   - focus leaving both the anchor and the layer
   - the window blur into an embedded frame, as
     [a window blur closes a popover](window-blur-closes-a-popover.md) says
4. Let the primitive anchored to such a control use the option. Users whose anchor is the invoker keep light dismiss.
5. Do not reopen the popover after a close a press on the anchor caused, neither in the primitive nor in its caller.

The owner chose that a press on the anchor keeps the popover open, without stating more of a reason. The option chosen
fixes the close where it happens, in the shared layer, as an option on the existing layer rather than a second one, in
the way [an existing call needs a variant](existing-call-needs-a-variant.md) describes.

## Example

```tsx
// The list drops from a field, which cannot invoke a popover.
<Floating anchor={queryField} selfDismiss open={open()} onClose={hideHints}>
  <HintList items={hints()} />
</Floating>;

// Inside Floating, the option swaps the browser's light dismiss for the layer's own closes.
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
// The layer light-dismisses on a press in the field, and the caller reopens it.
<Floating anchor={queryField} open={open()} onClose={(cause) => (cause.onAnchor ? reopen() : hideHints())}>
  <HintList items={hints()} />
</Floating>
```

## Cases

- A list primitive built on the shared floating layer in light-dismiss mode was anchored to a text field and the bar
  around it, and its caller held every close until the user typed, so a press in the field hid the list. Offered to
  accept it, to give the layer an option that runs its own closes, or to reopen after an anchor press, the owner chose
  that the press keeps the list open through the layer's option. (architecture change "Action group More: Listbox on
  wide screens", docs/\_plans/more-listbox-design.md, branch `feat/landing-horizon`)

Status: active
