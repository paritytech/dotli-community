# One form of a responsive component changes

A shared component has a wide-screen form and a phone form, such as an anchored surface on wide screens and a bottom
sheet on phones. It already picks the form when it opens and follows the viewport while open. A developer finds that its
user needs a different primitive on one form only, one that changes how the form behaves, such as its role, which
element holds focus or which element owns the active item. The other form stays as it is. The question is where the
switch between the two forms lives: inside the shared component, in the user that picks by viewport, or in a new
component that pairs the new primitive with the unchanged form. Once the two forms follow different patterns, a second
question follows: what role and ARIA the trigger carries, and which keys it handles, since one form may be driven from the
trigger while the other moves focus into its rows. The old form may have had a key the new pattern does not need, such as
a letter that jumps to the next row starting with it.

## How to resolve

1. Keep the switch between the forms inside the shared component.
2. Change the one form inside the component, so that form renders the new primitive.
3. Let the component's item part render as the matching part of each form, such as a list option on one form and a sheet
   row on the other.
4. Let the trigger carry the ARIA of the form that shows, such as a combobox that points at its active option on one form
   and a menu button on the other. It switches when the viewport crosses the breakpoint, and the server-rendered markup
   carries the attributes of the form the page is rendered in.
5. Let the trigger of the changed form handle the keys its new pattern needs, such as the arrows, Home, End, Enter and
   Escape. Do not carry over a key only the old form had, such as the letter-key jump. The unchanged form keeps every key
   it had.
6. Do not force one pattern onto both forms, neither by giving the unchanged form's rows the new roles nor by dressing
   the new form in the old roles.
7. Leave the user's code as it is: it keeps passing the same items.
8. Do not let the user pick a component by viewport, and do not add a new component to replace the old one.

The owner chose this without stating a reason. The option chosen keeps the one place that already picks the form and
follows the viewport, so the user never learns which form is showing. The owner also chose, again without a reason, that
the trigger follows the form over one shared pattern for both, and that the changed form drops the letter-key jump the
old form had while the unchanged form keeps it.

## Example

```tsx
// The user is unchanged on either form.
<Popout trigger={<MoreButton />}>
  <Popout.Item onSelect={rename}>Rename</Popout.Item>
  <Popout.Item onSelect={remove}>Remove</Popout.Item>
</Popout>;

// Inside Popout, the form picks what it renders.
const Item = (props: ItemProps) =>
  form() === 'wide' ? <PickList.Option {...props} /> : <Sheet.Row {...props} />;

// The trigger's ARIA follows the same form.
const triggerAria = () =>
  form() === 'wide'
    ? { role: 'combobox', 'aria-haspopup': 'listbox', 'aria-activedescendant': activeId() }
    : { 'aria-haspopup': 'menu' };

// On the wide form the trigger handles the list's keys only. The sheet rows keep their own keys, the letter jump too.
const onTriggerKey = (event: KeyboardEvent) => {
  if (form() !== 'wide') return;
  if (event.key === 'ArrowDown') moveActive(1);
  else if (event.key === 'ArrowUp') moveActive(-1);
  else if (event.key === 'Home') setActive(first());
  else if (event.key === 'End') setActive(last());
  else if (event.key === 'Enter') select(active());
  else if (event.key === 'Escape') close();
};
```

Not this:

```tsx
// The user picks by viewport.
{isWide() ? <PickList anchor={button}>…</PickList> : <Popout>…</Popout>}
```

## Cases

- A responsive dropdown that opened an anchored surface on wide screens and a bottom sheet on phones had one user, whose
  wide form had to become a passive list primitive driven by the control that opens it. The owner put the change inside
  the dropdown, with its item part rendering per form, rather than in the user or in a new component. (architecture
  change "Action group More: Listbox on wide screens", docs/\_plans/more-listbox-design.md)
- In the same dropdown, the trigger opened a listbox it drove on wide screens and a menu sheet whose rows take focus on
  phones, with the viewport able to cross the breakpoint while open and the page server-rendered as wide. The owner had
  the trigger follow the form, a combobox on wide screens and a menu button on phones, over one pattern for both.
  (architecture change "Action group More: Listbox on wide screens", docs/\_plans/more-listbox-design.md)
- In the same dropdown, the wide form had been a menu whose rows took focus, with a printable letter jumping to the next
  row starting with it, and became a listbox driven from its combobox trigger. The list held a handful of rows. The owner
  dropped the letter-key jump on wide screens only, and the phone sheet kept every key. (architecture change "Action group
  More: Listbox on wide screens", docs/\_plans/more-listbox-design.md)

Status: active
