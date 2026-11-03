# `@dotli/ui`

The UI of dotli that more than one app shows: primitives, floating layers, the action group, the toast and dialog stores
and views, the error page and the page's notifications, the icons, design tokens and the brand marks. It has no domain
and no data source.

## Responsibility

- The toast and modal stores, where everything that decides how a toast or dialog settles lives, and page helpers: the
  controls Tab reaches, idle preload, the phone viewport, reduced motion and the status tones.
- Primitives (`Button`, `Switch`, `StepSlider`, `Accordion`, `Chip`, `Surface`, `Well` and others) and the floating
  layers (`Modal`, `Popover`, `Tooltip`).
- The action group: a row of actions that moves what does not fit into a More menu.
- The toast view, which the overlays render from the toast store.
- Mounting a view inside an error boundary, and the overlay container.
- The screens and overlays both apps show: the error page and its frame, the notifier (a toast, and a system
  notification for a hidden tab), the prompt dialog every app asks through and the outlet that shows the modal queue,
  and the reload offer for a page chunk that fails to load.
- The generic icons, those with no domain.
- Design tokens, global styles and the logo.
- Not owned: domain views. Failures it recovers from go to the shared error capture, which tests rebind.

## Design

- The toasts, the dialog queue and the page screen are entity objects, each built by a factory with one page instance
  built with the defaults. The toasts and the page screen take the page as a param, and the toasts the timers too. The
  dialog queue takes none. Building one reads neither the document nor the clock: the document is read on first use. The
  dialog queue, the toasts and the page screen keep their state in an atom. Each exposes it read-only as `store` and
  registers its own state reset, so the store registry's reset resets every instance. The overlays render their state
  and everything else opens, pushes and settles through them. A toast's countdown runs only while a toast view is
  mounted and pauses while the tab is hidden or the stack is expanded. A toast's `onDismiss` that throws is reported as
  a listener error, counted as `listener.delivery`, and the toast leaves anyway.
- Every component has a CSS module beside it. Colors come only from the tokens.
- Floating layers share one stack that tracks shown modal layers and makes the page inert under the top one.
- `Popover` and `DropdownMenu` render their surface from its first opening on and share the trigger wiring. A popover's
  heavy content is the app's to load with `lazy()`, and its `preload` runs when the browser is idle.
- The action group measures its items and moves the lowest priority ones into More, which lists them as menu rows and
  raises their status as its badge. Items join through `ActionsContext` and say how they read as a row. The group waits
  out a container's resize animation and measures once it ends.
- `ToastStack` only renders the toast store, which decides how a toast settles. A dialog carries its icon as a
  component. A toast may carry one, and without one the card draws its tone's, so raising a toast imports no component.
- Text goes into the error page and the notifier as text, so nothing a visitor typed is parsed as markup. An action
  carries its icon as a component. Every `icon` prop takes the icon component, except `Choice` and `SegmentedControl`,
  whose slot takes markup.
- A disabled `SegmentedControl` keeps its options focusable and ignores presses, so a popover it sits in stays open.
- `StepSlider` commits the stop a pointer release, a stop's label, Enter or Space picks, the current one included, so
  its owner decides what a repeat means. A step key commits only a step, so at an end it commits nothing. A pointer the
  browser cancels commits nothing. While a pointer is held the thumb follows it freely and the nearest stop is the one
  shown. `marked` hollows the thumb for a value that is a stop only approximately, and sets `data-marked` on the track.
- `Accordion` is the native disclosure element, so the keyboard and screen readers get its semantics from the browser.
  Without `open` the browser opens and closes it. With `open` its owner holds the state, and a press on the header only
  reports the next state through `onToggle`. It animates its height where the browser can transition to `auto`, opens at
  once elsewhere, and never animates under reduced motion.
- `pageScreen.show` renders a screen's view into its own element in `#app`, or in the body of a page without one, which
  the screen then fills itself. It keeps the element marked `data-overlays`. The screen before goes first.
  `pageScreen.clear` takes it down and keeps what the page put beside it, such as the product frame. `pageScreen.store`
  says `screen` while one is shown, so what the screen covered can end itself. A view that throws is reported.
- Toasts and dialogs are queued on the stores and show once the app has mounted `Overlays`, in a container it marks
  `data-overlays` so that a full-page screen keeps it.
- The notifier always shows a toast. While the tab is hidden or its window has lost focus, it also fires a system
  notification, when the browser has one and the user allowed it. Without one, the toast stays in the page until closed,
  so it is not lost unseen.
- Every icon is a Solid component that draws an `<svg>` in `currentColor`, one module per icon. It keeps the size,
  stroke and geometry it was drawn at, and takes a `size` for another size, a `class` and a test id.
- `mountRoot` renders a view inside a root boundary. A view that throws is reported once under the root's name and the
  root is disposed.
- One root boundary reports a broken root once and renders nothing in its place. The mounted roots, the floating layers
  and the apps' islands use it, each with its own stand-in.
- Eslint refuses chain libraries and any domain package.

## Public API

### `@dotli/ui`

- Primitives: `Accordion` with `AccordionProps`, `Button`, `ButtonLink`, `Chip`, `IconButton`, `IconTile`, `Choice`,
  `SegmentedControl`, `StepSlider`, `Spinner`, `StatusDot`, `Surface` (with `SurfaceHead`, `SurfaceFoot`, `Hint`),
  `Switch`, `Well`, `Callout`, `Row`, `Stack`, `SectionLabel`.
- Floating layers: `Modal`, `Popover` and `usePopover`, `Tooltip`, plus the layer tracking (`LayerTracker`,
  `ModalFocusFallback`). A `Modal` whose content swaps in place names the value it swaps on with `refocusOn`, and focus
  moves to its card or sheet each time that value changes while it is open. Opening places focus through `initialFocus`.
  With `placement="topbar-end"` the same card hangs from the topbar's end.
- Action group: `ActionGroup`, `ActionItem`, `ActionsContext`, `PINNED` for an item that never collapses, and the types
  `ActionGroupMorph`, `MoreIds`, `ActionAlert`, `ActionBar` and `ActionEntry`.
- Stores: the page's dialog queue `modals` (`modals.store`, `modals.open(view, { signal, handoff })`,
  `modals.settle(id, result, { value })`, and `modals.refuseAll`, which answers every dialog with its refusal while the
  overlays cannot render, and `modals.dispose`, which rejects the open dialogs with an `AbortError` and tells a
  handed-off view it was aborted, with the types `ModalView`, `ModalOutcome`, `ModalEntry`, `ModalField`, `ModalButton`,
  `ModalButtonVariant`, `ModalHandoff`) and the page's toasts `toasts` (`store`, `show`, `push`, `dismiss`, `remove`,
  `dismissAll`, `setExpanded`, `clear`, `dispose`, which also stops the page listener, and the type `ToastEntry`).
  `modals.open` takes an optional handoff: once the dialog is answered it returns the view that takes the dialog's place
  without closing it, until a button, Escape, the scrim or its signal closes that view. The new view starts with an
  empty password field and focus on the dialog, not a button, so a second press cannot answer it at once. A view's own
  `body` describes the dialog, so a screen reader reads the new step when focus lands there. A handoff that throws is
  reported and the dialog closes as without one. A view may draw its own `body` and set `closable: false` to hide the
  sheet's close button.
- Page helpers: `focusables`, `runWhenIdle(run, timeoutMs, { scheduler, timers })` and
  `preloadWhenIdle(component, { scheduler, timers })`, `isPhoneViewport`, `watchPhoneViewport`, `prefersReducedMotion`
  and the type `StatusTone`.
- Helpers: `createDrags({ selection })` with the type `Drags` (one owner for a component's pointer drags, which cancels
  every drag still held when the component cleans up), `isFocusLostOrInside`, `focusTrigger`.
- Roots: `mountRoot({ name, container, view, removeContainer, onBroken })`, `RootBoundary`, `ensureOverlayRoot`.
- Screens and overlays: `showErrorPage` and `showError(title, { detail, action, tips })` with the types `ErrorAction`,
  `ErrorPageContent`, `ErrorText` and `ShowErrorPage`, `ErrorFrame` and `ErrorDetail` with `ErrorFrameProps`, the page's
  screen slot `pageScreen` (`pageScreen.store`, `pageScreen.show`, `pageScreen.clear`, `pageScreen.dispose`) and the
  type `PageContent`, `Overlays`, `showNotification` with the types `NotificationParams` and `ShowNotification`,
  `createReloadOffer({ notify, reload })`, the page's one reload offer, and
  `listenForChunkFailures({ target, offerReload })` (a failure is counted as `chunk.preload`).

### `@dotli/ui/testing`

Fakes for other packages' specs, stories and functional tests. Never imported by shipped code.

- Dialogs, answered on the page's dialog queue as its buttons and backdrop would: `shownModal`, `chooseModalButton`,
  `dismissModal`. Modal and toast state reset with the store registry's reset. Viewport: `PHONE_QUERY`.
- Other: `settle`, the page queries `appears`, `byId`, `byTestId`, `query`, and `installPopoverPolyfill` for functional
  tests under happy-dom.

### `@dotli/ui/brand`

`LogoSymbol`, `LogoWordmark` and `PetalMark`, the logo as six petals that pulse one after another with `pulse`. Astro
renders them at build time with no directive, so there they ship no code.

### `@dotli/ui/icons`

The icons, each a component named `<Thing>Icon` (`CloseIcon`, `InfoIcon`, `ReloadIcon`, `LockIcon`, `SendIcon` and the
rest), and the `IconProps` they take. The entry carries no stylesheet. Astro markup renders them at build time with no
directive.

### `@dotli/ui/styles.css`

The tokens and global styles. The apps import it once.
