# An element has to span a shared primitive's padding

An app's feature renders inside a container primitive from the shared UI package, such as a panel whose layouts set
their own inner padding. A design wants an element inside it that ignores that padding and runs edge to edge. The element
has no domain of its own, only a look, such as an icon and a short line in a tone. No primitive for it exists, and only
one app screen wants it now. The question is whether the app draws it and works around the container's padding, or the
shared package gains it.

## How to resolve

1. Add the element as a new primitive in the shared UI package, beside the primitives it sits among.
2. Style it in the container's own stylesheet, where the padding it cancels is set, so it follows every layout of the
   container, the phone one included.
3. Export it from the package's public entry.
4. Let the app's feature compose it and pass only content and tone.
5. Do not cancel the padding from the app with negative margins that repeat the container's tokens, and do not expose the
   container's padding as custom properties for the app to read.

The owner chose this without stating a reason. It keeps the padding and the element that undoes it in one stylesheet,
so a change to the container's layout cannot leave the app's copy behind.

## Example

```text
packages/kit/src/
  inset/
    Inset.tsx
    InsetRow.tsx
    InsetNote.tsx          new primitive, content and tone only
    Inset.module.css       sets the padding and the note's edge-to-edge rule
  index.ts                 exports InsetNote
apps/site/src/features/billing/
  PlanList.tsx             <InsetRow …/> <InsetNote tone="warn">…</InsetNote>
```

Not this:

```css
/* apps/site/src/features/billing/PlanList.module.css */
.note {
  margin-inline: calc(-1 * var(--sp-4));
}
```

## Cases

- A tinted note strip under some rows of a shared sunken panel, wanted by one screen, became a new primitive in the
  shared UI package, styled in the panel's stylesheet. (PR #484, branch `feat/browser-device-permissions`)

Status: active
