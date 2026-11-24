# A page mode moves a shared component

An app enters a page mode that changes where a component of the domain-free shared UI package must sit. For example, a
wide side panel must start below a band the app opens at the top of the page, and the band's height changes while the
mode holds. The component cannot know about the app's mode. The question is how it learns its new placement: through a
new custom property of its own, a prop the app passes, package CSS that matches the app's page attribute, or the app
styling the package's element.

## How to resolve

1. Look for page-wide layout variables the shared package already defines in its global stylesheet for the area the
   page's content fills, such as its top and bottom content edges, and that other parts of the package already read.
2. Have the component inset from those variables, as the package's other layers do.
3. Have the app's page mode redefine the variable for the edge that moves, such as setting the top edge to the band's
   height, and let it follow the band as its height changes.
4. Let everything else that reads the same edges follow the mode with no change of its own.
5. Add no new custom property on the component, no inset prop, no package CSS that names the app's attribute and no app
   CSS that styles the package's element.

The owner chose the existing content edges over a new interface without stating a further reason. Reusing them keeps
the package domain-free, adds no interface, and moves every layer that reads the edges together with one value.

## Example

```css
/* The shared package's global stylesheet, already there. */
:root {
  --content-top: var(--header-height);
  --content-bottom: var(--safe-bottom);
}

/* The shared panel insets from the edges, as the package's sheet already does. */
.panel {
  top: var(--content-top);
  bottom: var(--content-bottom);
}

/* The app's page mode moves the edge. */
:root[data-focus-mode] {
  --content-top: var(--banner-height);
}
```

Not this:

```tsx
<SidePanel insetTop="var(--banner-height)">…</SidePanel>
```

```css
.panel {
  top: var(--side-panel-top, var(--header-height));
}
:global([data-focus-mode]) .panel {
  top: var(--banner-height);
}
```

## Not when

The component is a surface that opens from a trigger. It places itself against its trigger, as
[a surface is placed against its trigger](surface-placed-against-its-trigger.md) says, and reads no bar or page edge.

## Cases

- A chat drawer's wide side panel had to start below a band an app's staged mode opens at the top of the page, a band
  that folds while the mode holds. Offered a new top-inset custom property with a fallback, an inset prop, package CSS
  matching the app's attribute or app CSS on the package element, the owner chose the existing content-edge variables,
  with the stage setting the top edge to the band's height. (architecture change, design
  docs/\_plans/staged-mode-design.md)

Status: active
