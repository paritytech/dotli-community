# A surface is placed against its trigger

A developer gives a new user to a shared surface that opens from a trigger, such as a list that drops below the control
that opens it, or a tooltip card. The surface places itself in its own way, for example absolutely below its nearest
positioned ancestor, while the package's other surfaces are placed against their trigger. Or the trigger sits in a bar
whose other surfaces drop from the bar's edge, and the surface's old look came from the app's own CSS lining it up with
that edge. The question looks like how a host, such as a shared floating layer, can hold the surface and place it for
this user, how the primitive can be split or switched off for a host, or what carries the bar's edge into the shared
component.

## How to resolve

1. Treat the question as a sign that placement sits in the wrong place. Placement is the surface's own job.
2. Make the surface place itself against its trigger, the control that opens it, through the same mechanism the
   package's other surfaces use, always and with no fallback, as
   [an existing component already does the job](existing-component-already-does-the-job.md) says.
3. Let any user get the right placement by naming the trigger, whatever container the trigger sits in.
4. Keep that placement when the trigger sits in a bar whose other surfaces drop from the bar's edge, a few pixels
   below the trigger. The surface still sits against the trigger's own edge, even when its old look dropped from the
   bar's edge.
5. Do not have a host strip the primitive's chrome and size to place it, do not split the primitive so a host draws its
   surface, and do not add a prop that turns its placement off for a host. Do not add a placement to the shared layer
   that aligns to the container instead, do not pass another element as the reference the surface drops from, and do
   not have the opener override the surface's position in its own CSS.

The owner's reason: a dropdown positions itself against its anchor like every other dropdown, and a question about how a
host should place one shows the responsibility was split wrong. Offered to align a surface with the bar's other
surfaces, the owner kept it against the trigger, with no parameter, without stating a further reason.

## Example

```tsx
// The surface places itself against the control that opens it.
<PickList trigger={sortButton} items={orders} onPick={sortBy} />;
<InfoCard trigger={addressPill}>{details}</InfoCard>;

// Inside PickList, the same placement the package's other surfaces use.
const PickList = (props: PickListProps) => {
  const anchored = createAnchoredTo(props.trigger);
  return <ul {...anchored.attrs}>{/* options */}</ul>;
};
```

Not this:

```tsx
// A host places the primitive and undoes its own placement.
<FloatingHost class={s['bare']} trigger={sortButton}>
  <PickList unpositioned items={orders} onPick={sortBy} />
</FloatingHost>

// The card drops from the bar's edge through another element or a bar placement.
<InfoCard trigger={addressPill} dropFrom={toolbar}>{details}</InfoCard>
<InfoCard trigger={addressPill} placement="below-bar">{details}</InfoCard>
```

Nor this, to line it up with the bar's bottom edge:

```css
/* The opener moves the list from the trigger's edge to the bar's. */
.sortList {
  top: var(--toolbar-bottom);
}
```

## Cases

- A passive list primitive dropped below its nearest positioned ancestor, and a new user opened it from a button inside
  a fixed bar that clips its overflow. Asked whether the package's floating layer should host it bare, draw a surface
  around a split-off list part, or have a prop turn its placement off, the owner rejected all three: the list places
  itself against its trigger like every other dropdown. (architecture change "Action group More: Listbox on wide
  screens", docs/\_plans/more-listbox-design.md). The same change's form switch is in
  [one form of a responsive component changes](one-form-of-a-responsive-component-changes.md).
- In the same change, the trigger was a button centred in a fixed top bar, its bottom a few pixels above the bar's,
  and the bar's other surfaces drop from the bar's bottom. Offered a new bar-aligned placement in the floating layer, or
  an opener override of the list's top, the owner kept the list against the button's bottom edge with no extra code.
  (architecture change "Action group More: Listbox on wide screens", docs/\_plans/more-listbox-design.md)
- A shared tooltip card moved onto the floating layer had to align with its trigger on one axis and with the bar's
  bottom edge on the other, as the app's own CSS had placed it. Offered an element prop for the edge to drop from or a
  named placement reading the bar's published custom property, the owner kept the card against the trigger's own
  bottom edge with no parameter, a few pixels above the bar's other surfaces. (architecture change, design
  docs/\_plans/floating-placement-design.md, branch feat/floating-ui)

Status: active
