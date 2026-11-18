# A listbox option needs a remove action

A combobox keeps focus in its input and drives a popup built from a shared listbox primitive that knows no domain. A
feature wants each row to offer a remove action, so a user can delete one entry, such as a past search, from the list.
ARIA lets a listbox own only options and groups, and an option may not contain an interactive control. The question is
how the shared primitive offers the action without breaking the listbox pattern.

## How to resolve

1. Keep the popup a listbox. Do not switch it to a grid with a cell per action.
2. Give the primitive's option one optional remove field, an object with the callback and its label. Do not open a slot
   where the caller puts its own control, so the primitive keeps the accessibility and keys in one place.
3. Render the remove control in the row as a real button for mouse and touch, kept out of the tab order and out of the
   accessibility tree.
4. Let keyboard and screen reader users remove the active option with Shift+Delete, handled in the combobox's key
   handling and announced on the option through `aria-keyshortcuts`.

The owner chose this without stating a reason. It keeps a valid listbox, so arrow keys and the input's focus work as
before, while every kind of user can still remove a row.

## Example

```tsx
// The caller passes data only.
<Picker
  options={recent.map((entry) => ({
    id: entry.id,
    label: entry.title,
    remove: { onRemove: () => forget(entry.id), label: `Remove ${entry.title}` },
  }))}
/>

// The primitive renders the pointer control and announces the key.
<li role="option" id={option.id} aria-keyshortcuts={option.remove ? 'Shift+Delete' : undefined}>
  {option.label}
  {option.remove && (
    <button tabIndex={-1} aria-hidden="true" onClick={option.remove.onRemove} title={option.remove.label}>
      <CloseIcon />
    </button>
  )}
</li>

// The combobox's key handling removes the active option.
if (event.key === 'Delete' && event.shiftKey) active()?.remove?.onRemove();
```

Not this:

```tsx
<Picker role="grid" />              // a grid with a name cell and a remove cell per row
<PickerOption trailing={<button />} /> // an open slot the caller fills
```

## Cases

- A landing page redesign has a combobox that shows history entries in a shared listbox popup, and each entry needed a
  remove action. The option gained an optional remove object, a hidden pointer button and Shift+Delete. (issue
  paritytech/dotli-community#92, design `docs/_plans/landing-horizon-design.md`)

Status: active
