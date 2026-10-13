# `@dotli/ui`

The base of the UI stack: the page's toast and modal stores and its helpers, primitives, floating layers, the action
group, the toast view, the icons, design tokens and the brand marks. It has no domain and no data source, so every other
UI package builds on it.

## Responsibility

- The toast and modal stores, where everything that decides how a toast or dialog settles lives, and page helpers: the
  controls Tab reaches, idle preload, the phone viewport, reduced motion and the status tones.
- Primitives (`Button`, `Switch`, `Chip`, `Surface`, `Well` and others) and the floating layers (`Modal`, `Popover`,
  `DropdownMenu`, `Tooltip`).
- The action group: a row of actions that moves what does not fit into a More menu.
- The toast view, which renders the toast store.
- Mounting a view inside an error boundary, and the overlay container.
- The generic icons, those with no domain.
- Design tokens, global styles and the logo.
- Not owned: domain views, shared screens and overlay mounting. Failures it recovers from go to the metrics package's
  capture, which tests rebind.

## Design

- The stores are sync stores built on `createSyncStore`. The overlays render their state and everything else opens,
  pushes and settles through them. A toast's countdown pauses while the tab is hidden or the stack is expanded.
- Every component has a CSS module beside it. Colors come only from the tokens.
- Floating layers share one stack that tracks shown modal layers and makes the page inert under the top one.
- `Popover` and `DropdownMenu` render their surface from its first opening on and share the trigger wiring. A popover's
  heavy content is the app's to load with `lazy()`, and its `preload` runs when the browser is idle.
- The action group measures its items and moves the lowest priority ones into More, which lists them as menu rows and
  raises their status as its badge. Items join through `ActionsContext` and say how they read as a row. The group waits
  out a container's resize animation and measures once it ends.
- `ToastStack` only renders the toast store, which decides how a toast settles. A toast or dialog carries its icon as a
  component, which the views draw. The dialog that renders the modal queue lives with the shared widgets.
- Every icon is a Solid component that draws an `<svg>` in `currentColor`, one module per icon. It keeps the size,
  stroke and geometry it was drawn at, and takes a `size` for another size, a `class` and a test id.
- `mountRoot` renders a view inside an error boundary. A view that throws is reported once under the root's name and the
  root is disposed.
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
- Stores: the modal store (`openModal`, `settleModal`, `modalsStore` and the types `ModalView`, `ModalOptions`,
  `ModalOutcome`, `ModalEntry`, `ModalButton`, `ModalButtonVariant`) and the toast store (`pushToast`, `clearToasts`,
  `toastsStore`, `dismissToast`, `removeToast`, `dismissAllToasts`, `setToastsExpanded` and the types `ToastInput`,
  `ToastEntry`).
- Page helpers: `focusables`, `preloadWhenIdle` with `IdleScheduler`, `isPhoneViewport`, `watchPhoneViewport`,
  `prefersReducedMotion` and the type `StatusTone`.
- Helpers: `useStore`, `startDrag`, `focusLostOrInside`, `focusTrigger`.
- Roots: `mountRoot`, `ensureOverlayRoot`.
- Overlay view: `ToastStack`, which the page's overlays render.

### `@dotli/ui/testing`

Fakes for other packages' specs, stories and functional tests. Never imported by shipped code.

- Modal store: `modalsStore`, `resetModalsForTests`, `shownModal`, `chooseModalButton`, `dismissModal`. Toasts:
  `bindToastPage`, `resetToastsForTests`. Viewport: `PHONE_QUERY`, `resetPhoneViewport`.
- Other: `settle`, and the page queries `appears`, `byId`, `byTestId`, `query`.

### `@dotli/ui/brand`

`LogoSymbol`, `LogoWordmark` and `PetalMark`, the logo as six petals a stylesheet can pulse. Astro renders them at build
time with no directive, so there they ship no code.

### `@dotli/ui/icons`

The icons, each a component named `<Thing>Icon` (`CloseIcon`, `InfoIcon`, `ReloadIcon`, `LockIcon`, `SendIcon` and the
rest), and the `IconProps` they take. The entry carries no stylesheet. Astro markup renders them at build time with no
directive.

### `@dotli/ui/styles.css`

The tokens and global styles. The apps import it once.
