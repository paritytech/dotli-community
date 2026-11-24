# Closing a panel focuses an auto-hiding bar

A developer works on a panel, such as a side drawer, that opens from a button inside a bar that hides itself and shows
again when focus enters it. On close the panel hands focus back to its button, as an accessible dialog does. The
developer notices that a close with the mouse or a tap now unfolds a folded bar the user never asked to see. The
question is which piece changes: the bar, so it shows on focus only when focus came from the keyboard, or the panel's
focus return. Once the return depends on how the panel closed, a second question follows: which unit owns it when both
the panel and the feature that opens it return focus today, in no fixed order.

## How to resolve

1. Leave the bar's reveal on focus as it is. Do not teach the bar to tell keyboard focus from other focus, and do not
   build a page-wide input-modality helper for it, as
   [a focus ring only for keyboard focus](focus-ring-only-for-keyboard-focus.md) also says of a ring.
2. Let the panel own its focus return. It knows from its own close whether a pointer or the keyboard closed it, so it
   picks the target. The opener only hands itself to the panel as the element to return to. Delete the opener's own
   focus return, so one unit moves focus.
3. Make the return depend on how the panel closed:
   - closed by the keyboard, such as Escape or Enter on its close button: focus returns to the button that opened it
   - closed by a pointer, such as a press on its close button or outside it: the target is what one prop on the panel
     picks, either the button that opened it, the default, or focus released to the document without moving it
     anywhere
4. Have the caller whose opener sits in such a bar set the prop to release focus. Other callers keep the default.
5. Keep returning focus to the button for keyboard users. Do not drop the return for every close.

The owner put the focus return in the panel, with a prop that says whether a pointer close returns focus to the opener
or only resets it to the window. It keeps the keyboard user's place at the button, a pointer user, who needs no focus
mark, never sets off the bar's reveal, and the panel's other callers keep the standard return.

## Example

```tsx
// The panel owns the return. The opener only hands itself over.
const close = (via: 'pointer' | 'keyboard') => {
  setOpen(false);
  if (via === 'pointer' && props.pointerClose === 'release') {
    (document.activeElement as HTMLElement | null)?.blur();
  } else {
    props.opener?.focus();
  }
};

<SidePanel opener={menuButton} pointerClose="release" />;
```

Not this:

```ts
// The opener's feature returns focus too, racing the panel's own return.
panel.onClose(() => menuButton.focus());

// Or the bar guesses where focus came from through a page-wide tracker.
bar.addEventListener('focusin', () => {
  if (lastInput() === 'keyboard') reveal();
});
```

## Cases

- In an app's staged mode, a drawer opens from a button in a topbar that folds and unfolds whenever focus enters it, so
  a pointer close of the drawer unfolded the folded topbar. Offered a bar that unfolds only on keyboard focus through a
  page input-modality helper, a focus return by how the drawer closed, or no return to the button at all, the owner
  chose the return by how it closed, at first sending a pointer close to the product frame. (architecture change,
  design docs/\_plans/staged-mode-design.md)
- In the same change, both the shared drawer and the topbar's feature returned focus, in separate islands and no fixed
  order. Offered the drawer owning the return with the opener handed in as its restore target, the opener's feature
  owning it through a close reason, or both returning and coordinating, the owner chose the drawer. The owner added a
  prop on the drawer that picks between returning focus to the opener and resetting it to the window, which replaced
  the product frame as the pointer-close target. (architecture change, design docs/\_plans/staged-mode-design.md)

Status: active
