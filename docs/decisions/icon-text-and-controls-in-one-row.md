# A row with an icon, a title over a body and trailing controls

You are laying out a compact card or row: a leading icon, a title with a body line under it, and trailing controls such
as an action button and a close button. The controls are taller than the title's line. A grid that gives the title its
own row, shared with the icon and the controls, looks tidy, but a taller control stretches that row. The question is how
to place the three parts so the controls never move the text.

## How to resolve

1. Make the card one flex row with its items centred on a shared centre line: the icon, the text, then the controls.
2. Stack the title and the body in a column of their own, and let their own line heights space them. Never put the
   title in a row or a track the controls share.
3. Let the icon centre on the whole card, not on the title's line.
4. Keep the icon and the controls at their own size, and let the text column take the rest of the width.

The owner's reason: in the grid, the close button opened a gap between the title and the body, and the icon sat in an
awkward place. A control taller than the title must never change the spacing between the title and the body.

## Example

The grid this replaces, where the title's row grows to the tallest control:

```css
.item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
}
.glyph {
  grid-area: 1 / 1;
}
.dismiss {
  grid-row: 1;
}
```

One row on a shared centre line, with the text in its own column:

```css
.item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.glyph,
.dismiss {
  flex: none;
}
.words {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
```

## Cases

- The toast card placed its icon and controls in the title's grid row. The close button spread the title from the body
  and the icon looked misplaced. It became one flex row with the text stacked in its own column. (branch
  `fix/toast-layout`)

Status: active
