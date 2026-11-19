# A dropdown is placed against its trigger

A developer gives a new user to a shared primitive that opens as a dropdown, such as a list that drops below the
control that opens it. The primitive places itself in its own way, for example absolutely below its nearest positioned
ancestor, while the package's other dropdowns are placed against their trigger. The new user's trigger sits where that
way breaks, such as inside a bar that clips its overflow. The question looks like how a host, such as a shared floating
layer, can hold the primitive and place it for this user, or how the primitive can be split or switched off for a host.

## How to resolve

1. Treat the question as a sign that placement sits in the wrong place. Placement is the dropdown's own job.
2. Make the primitive place itself against its trigger, the control that opens it, through the same mechanism the
   package's other dropdowns use, always and with no fallback, as
   [an existing component already does the job](existing-component-already-does-the-job.md) says.
3. Let any user get the right placement by naming the trigger, whatever container the trigger sits in.
4. Do not have a host strip the primitive's chrome and size to place it, do not split the primitive so a host draws its
   surface, and do not add a prop that turns its placement off for a host.

The owner's reason: a dropdown positions itself against its anchor like every other dropdown, and a question about how a
host should place one shows the responsibility was split wrong.

## Example

```tsx
// The primitive places itself against the control that opens it.
<PickList trigger={sortButton} items={orders} onPick={sortBy} />;

// Inside PickList, the same placement the package's other dropdowns use.
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
```

## Cases

- A passive list primitive dropped below its nearest positioned ancestor, and a new user opened it from a button inside
  a fixed bar that clips its overflow. Asked whether the package's floating layer should host it bare, draw a surface
  around a split-off list part, or have a prop turn its placement off, the owner rejected all three: the list places
  itself against its trigger like every other dropdown. (architecture change "Action group More: Listbox on wide
  screens", docs/\_plans/more-listbox-design.md). The same change's form switch is in
  [one form of a responsive component changes](one-form-of-a-responsive-component-changes.md).

Status: active
