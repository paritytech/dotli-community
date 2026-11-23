# An existing component already does the job

A developer changes a primitive so it does something another component of its package already does, such as placing a
surface against the control that opens it. The existing component has a gap the primitive's old way did not have, for
example it relies on a CSS feature some supported browsers lack and has no fallback for them. The question is whether to
give the existing component a fallback, to keep the primitive's old way where the gap shows, or to use the existing
component as it is.

## How to resolve

1. Build the primitive as a composition of the package's existing stable components.
2. When a component already does the job, use it in the primitive always, with no condition on the browser or the
   context.
3. Do not add a fallback path to that component for the places it does not cover.
4. Do not keep the primitive's old in-place way beside it for those places, and do not write a new special solution
   inside the primitive.

The owner's reason: a component is a composition of stable solutions without fallbacks, so when the package already has
a component that does a job, every primitive that needs the job uses it unconditionally instead of carving out its own.

## Example

```tsx
// The primitive composes the component that already anchors surfaces, always.
const PickList = (props: PickListProps) => (
  <Anchored trigger={props.trigger}>
    <ul role="listbox">{props.children}</ul>
  </Anchored>
);
```

Not this:

```tsx
// The primitive keeps its own placement where the shared component falls short.
const PickList = (props: PickListProps) =>
  supportsAnchoring() ? (
    <Anchored trigger={props.trigger}>{list(props)}</Anchored>
  ) : (
    <ul class={s['below-parent']}>{props.children}</ul>
  );
```

## Cases

- A list primitive was changed to place itself against its trigger through the package's floating layer, which uses CSS
  anchor positioning and has no fallback for browsers below the floor that lack it. Offered a script fallback in the
  floating layer, anchor positioning only through the floating layer, or the old in-place placement where anchoring is
  missing, the owner chose anchor positioning only through the floating layer, always. (architecture change "Action
  group More: Listbox on wide screens", docs/\_plans/more-listbox-design.md). The same change's placement rule is
  [a surface is placed against its trigger](surface-placed-against-its-trigger.md).

Status: active
