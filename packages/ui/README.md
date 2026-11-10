# `@dotli/ui`

The UI that more than one dotli app shows. It has no domain and no data source.

## Responsibility

**Owns:**

- The toast, dialog and page screen stores, which decide how a toast or dialog settles.
- Primitives, floating layers and the action group.
- The shared screens: the error page, the notifier, the prompt dialog, the modal outlet and the chunk reload offer.
- Mounting a view inside an error boundary, and the overlay container.
- Page helpers, generic icons, design tokens, global styles and the logo.

**Does not own:** domain views. ESLint refuses chain libraries and any domain package.

## Design

- **Stores render, others act:** `toasts`, `modals` and `pageScreen` hold their state in an atom. The overlays render
  it. Everything else opens, pushes and settles through the stores.
- **Overlays mount late:** toasts and dialogs queue until the app mounts `Overlays`. Its container is marked
  `data-overlays`, so a full-page screen keeps it.
- **One layer stack:** floating layers share one stack. It makes the page inert under the top modal layer.
- **Responsive popovers:** `Popover` and `DropdownMenu` anchor on a wide screen and become a bottom sheet on a phone.
  Heavy content is the app's to load with `lazy()`.
- **Action group:** moves the lowest priority items into a More menu when they do not fit. Items join through
  `ActionsContext`.
- **Icons as components:** every `icon` prop takes a component, except in `Choice` and `SegmentedControl`, whose slot
  takes markup.
- **Text only:** the error page and the notifier take text, so nothing a visitor typed is parsed as markup.
- **Notifier:** always shows a toast. A hidden or unfocused tab also gets a system notification when allowed.
- **Root boundary:** a broken root is reported once and renders nothing. Mounted roots, floating layers and the apps'
  islands all use it.

Traps:

- `StepSlider` commits the picked stop even when it is the current one. Its owner decides what a repeat means.
- `Accordion` with `open` is controlled. A header press only reports the next state through `onToggle`.
- A disabled `SegmentedControl` keeps its options focusable, so a popover around it stays open.

## Public API

### `@dotli/ui`

- **Primitives:** `Accordion`, `AccordionProps`, `Button`, `ButtonLink`, `ButtonVariant`, `Chip`, `IconButton`,
  `IconTile`, `Choice`, `SegmentedControl`, `SegmentOption`, `StepSlider`, `StepSliderProps`, `StepSliderStop`,
  `Spinner`, `StatusDot`, `Surface`, `SurfaceHead`, `SurfaceFoot`, `Hint`, `Switch`, `Well`, `Callout`, `Row`, `Stack`,
  `SectionLabel`.
- **Floating layers:** `Modal`, `Popover`, `usePopover`, `Tooltip`, `LayerTracker`, `ModalFocusFallback`,
  `TrackedLayer`.
- **Action group:** `ActionGroup`, `ActionItem`, `ActionItemProps`, `ActionsContext`, `PINNED` (never collapses),
  `ActionGroupMorph`, `MoreIds`, `ActionAlert`, `ActionBar`, `ActionEntry`.
- **Stores:** `modals` (the dialog queue), `toasts`, `pageScreen` (the full-page screen slot), and the types
  `ModalView`, `ModalOutcome`, `ModalEntry`, `ModalField`, `ModalButton`, `ModalButtonVariant`, `ModalHandoff`,
  `ToastEntry`, `PageContent`.
- **Page helpers:** `focusables`, `runWhenIdle`, `preloadWhenIdle`, `isPhoneViewport`, `watchPhoneViewport`,
  `prefersReducedMotion`, `StatusTone`.
- **Helpers:** `createDrags` with `Drags` (one pointer drag per component), `isFocusLostOrInside`, `focusTrigger`.
- **Roots:** `mountRoot`, `RootBoundary`, `ensureOverlayRoot`.
- **Screens and overlays:** `showErrorPage`, `showError`, `ErrorFrame`, `ErrorDetail`, `Overlays`, `showNotification`,
  `createReloadOffer`, `listenForChunkFailures`, and the types `ErrorAction`, `ErrorPageContent`, `ErrorText`,
  `ShowErrorPage`, `ErrorFrameProps`, `NotificationParams`, `ShowNotification`.

**Modal handoff:** `modals.open(view, { signal, handoff })` can return a next view once the dialog is answered. That
view replaces it without closing it, with focus on the dialog so a second press cannot answer it at once.

### `@dotli/ui/testing`

Fakes for other packages' specs, stories and functional tests. Never imported by shipped code.

| Export                                            | What it does                                       |
| ------------------------------------------------- | -------------------------------------------------- |
| `shownModal`, `chooseModalButton`, `dismissModal` | Answer the page's dialogs.                         |
| `PHONE_QUERY`                                     | The phone viewport query.                          |
| `settle`                                          | Flushes Solid's batched writes.                    |
| `appears`, `byId`, `byTestId`, `query`            | Page queries.                                      |
| `installPopoverPolyfill`                          | Popover support for functional tests on happy-dom. |

### `@dotli/ui/brand`

`LogoSymbol`, `LogoWordmark` and `PetalMark` (six petals that can `pulse`). Astro renders them at build time with no
directive, so they ship no code there.

### `@dotli/ui/icons`

One component per icon, named `<Thing>Icon` (`CloseIcon`, `InfoIcon` and the rest), and `IconProps`. No stylesheet.

### `@dotli/ui/styles.css`

The tokens and global styles. The apps import it once.
