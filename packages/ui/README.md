# `@dotli/ui`

The Solid layer of the UI stack: primitives, floating layers, the action group, the toast view, the icons, design tokens
and the brand marks. It builds on the UI core, which holds the roots, stores and helpers page startup takes. It has no
domain and no data source, so every other UI package builds on it.

## Responsibility

- Primitives (`Button`, `Switch`, `Chip`, `Surface`, `Well` and others) and the floating layers (`Modal`, `Popover`,
  `DropdownMenu`, `Tooltip`).
- The action group: a row of actions that moves what does not fit into a More menu.
- The toast view, which renders the toast store.
- Mounting a view into a page root, and the overlay container.
- The generic icons, those with no domain.
- Design tokens, global styles and the logo.
- Not owned: the roots, the toast and modal stores and the page helpers, domain views, shared screens and overlay
  mounting, metrics. A failure goes out through the `Reporter` the caller passes in.

## Design

- Every component has a CSS module beside it. Colors come only from the tokens.
- Floating layers share one stack that tracks shown modal layers and makes the page inert under the top one. It is kept
  apart from the modal view so anchored surfaces can ask it without loading the modal.
- `Popover` and `DropdownMenu` load their surface lazily. The trigger wiring and the chunk state are shared, so an
  opening and an idle preload use the same chunk.
- The action group measures its items and moves the lowest priority ones into More, which lists them as menu rows and
  raises their status as its badge. Items join through `ActionsContext` and say how they read as a row. The group waits
  out a container's resize animation and measures once it ends.
- `ToastStack` only renders the toast store, which decides how a toast settles. A toast's icon and a dialog's `IconTile`
  icon arrive as the store's icon components, which ui draws as the Solid components they are. The dialog that renders
  the modal queue lives with the shared widgets.
- Every icon is a Solid component that draws an `<svg>` in `currentColor`, one module per icon. It keeps the size,
  stroke and geometry it was drawn at, and takes a `size` for another size, a `class` and a test id.
- `mountRoot` renders a view inside an error boundary and registers it as a named page root, so a replacement disposes
  it. A root mounted as content is the page's own, which a full-page screen takes down. A broken root is disposed once
  and its owner recovers.
- Failures: the app passes a `Reporter` to `mountRoot`, or a surface reads it from `ReporterContext`. The package names
  no metrics package.
- Boot modules import only its stylesheet and its icons. Everything else they need comes from the UI core.
- Eslint refuses chain libraries and any domain package.

## Public API

### `@dotli/ui`

- Primitives: `Button`, `ButtonLink`, `Field`, `Chip`, `IconButton`, `IconTile`, `Choice`, `SegmentedControl`,
  `Spinner`, `StatusDot`, `Surface` (with `SurfaceHead`, `SurfaceFoot`, `Hint`), `Switch`, `Well`, `Callout`, `Row`,
  `Stack`, `SectionLabel`.
- Floating layers: `Modal`, `Popover` and `usePopover`, `DropdownMenu` and `useDropdownMenu`, `Tooltip`, plus the layer
  tracking (`LayerTracker`, `AnchorBoundary`, `ModalFocusFallback`).
- Action group: `ActionGroup`, `ActionItem`, `ActionsContext`, `PINNED` for an item that never collapses, and the types
  `ActionGroupMorph`, `MoreIds`, `ActionAlert`, `ActionBar`, `ActionEntry` and `MoreRow`.
- Helpers: `useStore`, `startDrag`, `focusLostOrInside`, `focusTrigger`, and `storeIcon`, which turns an icon the UI
  core stores back into the component it is.
- Reporting: `ReporterContext`.
- Roots: `mountRoot`, `ensureOverlayRoot`.
- Overlay view: `ToastStack`. Only the lazy overlays chunk imports it.

### `@dotli/ui/testing`

Fakes for other packages' specs, stories and functional tests. Never imported by shipped code.

- Popover: `createPopoverSurface`, `PopoverSurfaceContext`, `loadPopoverSurface`.
- Other: `settle`, and the page queries `appears`, `byId`, `byTestId`, `query`.

### `@dotli/ui/brand`

`LogoSymbol`, `LogoWordmark` and `PetalMark`, the logo as six petals a stylesheet can pulse. Astro renders them at build
time with no directive, so there they ship no code.

### `@dotli/ui/icons`

The icons, each a component named `<Thing>Icon` (`CloseIcon`, `InfoIcon`, `ReloadIcon`, `LockIcon`, `SendIcon` and the
rest), and the `IconProps` they take. Boot may import them, since a toast or dialog it opens carries the component, and
so does Astro markup, which renders them at build time with no directive.

### `@dotli/ui/styles.css`

The tokens and global styles. The apps import it once.
