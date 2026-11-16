# A screen mixes horizontal alignments

A screen, such as a dialog, a sheet or a status screen, has some text centred and some at the start edge. A polish pass
has to pick one, and moving everything to the start edge looks like the tidy choice.

## How to resolve

1. Centre the text and stretch the controls to full width.
2. Fix a mixed screen by centring the element that breaks it. Never move centred content to the start edge to match it.
3. Keep the start edge only where centring looks ugly.

The owner's reason: horizontal alignment kept causing trouble, and one simple default stops it. The default is
temporary, and the owner expects richer alignment rules later.

## Example

One element breaks a centred screen:

```css
.screen {
  text-align: center;
}
.message {
  text-align: start;
}
```

The fix drops the odd rule, so the element follows the screen, and the controls stretch:

```css
.screen {
  text-align: center;
}
.actions > * {
  inline-size: 100%;
}
```

## Not when

Centring looks ugly.

## Cases

- A polish pass moved the text of the phone sign-in sheets to the start edge. It went back to the centre. (branch
  `fix/ui-alignment`)

Status: active
