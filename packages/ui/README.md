# `@dotli/ui`

## Overview

The UI that more than one dotli app shows. It has no domain and no data source.

## Responsibilities

**Owns:**

- The toast, dialog and page screen stores, which decide how a toast or dialog settles.
- Primitives and floating layers.
- The action group.
- The shared screens:
  - the error page
  - the notifier
  - the prompt dialog
  - the modal outlet
  - the chunk reload offer
- Mounting a view inside an error boundary, and the overlay container.
- Page helpers and generic icons.
- Design tokens and global styles.
- The logo.

**Does not own:** domain views. ESLint refuses chain libraries and any domain package.

## Public API

### `@dotli/ui`

| Export                                                                                                                        | What it does                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `Accordion`, `AccordionProps`, `Button`, `ButtonLink`, `ButtonVariant`, `Chip`, `IconButton`, `IconTile`                      | Primitives.                                     |
| `Choice`, `SegmentedControl`, `SegmentOption`, `StepSlider`, `StepSliderProps`, `StepSliderStop`, `Spinner`                   | Primitives.                                     |
| `StatusDot`, `Surface`, `SurfaceHead`, `SurfaceFoot`, `Hint`, `Switch`, `Well`, `Callout`, `Row`, `Stack`, `SectionLabel`     | Primitives.                                     |
| `Listbox`, `RowNote`                                                                                                          | Primitives.                                     |
| `Drawer`, `Modal`, `Popover`, `usePopover`, `Tooltip`, `LayerTracker`, `ModalFocusFallback`, `TrackedLayer`                   | Floating layers.                                |
| `ActionGroup`, `ActionItem`, `ActionItemProps`, `ActionsContext`, `ActionGroupMorph`, `MoreIds`                               | The action group.                               |
| `ActionAlert`, `ActionBar`, `ActionEntry`                                                                                     | The action group.                               |
| `PINNED`                                                                                                                      | The action group priority that never collapses. |
| `modals`                                                                                                                      | The dialog queue store.                         |
| `toasts`                                                                                                                      | The toast store.                                |
| `pageScreen`                                                                                                                  | The full-page screen slot store.                |
| `ModalView`, `ModalOutcome`, `ModalEntry`, `ModalField`, `ModalButton`, `ModalButtonVariant`, `ModalHandoff`                  | Store types.                                    |
| `ToastEntry`, `PageContent`                                                                                                   | Store types.                                    |
| `focusables`, `runWhenIdle`, `preloadWhenIdle`, `isPhoneViewport`, `watchPhoneViewport`, `prefersReducedMotion`, `StatusTone` | Page helpers.                                   |
| `pinPageAboveKeyboard`                                                                                                        | Holds a page in place over the keyboard.        |
| `createDrags`, `Drags`                                                                                                        | One pointer drag per component.                 |
| `isFocusLostOrInside`, `focusTrigger`                                                                                         | Helpers.                                        |
| `mountRoot`, `RootBoundary`, `ensureOverlayRoot`                                                                              | Roots.                                          |
| `showErrorPage`, `showError`, `ErrorFrame`, `ErrorDetail`, `ErrorActions`                                                     | Screens and overlays.                           |
| `Overlays`, `showNotification`, `createReloadOffer`, `listenForChunkFailures`                                                 | Screens and overlays.                           |
| `ErrorAction`, `ErrorPageContent`, `ErrorText`, `ShowErrorPage`, `ErrorFrameProps`                                            | Screen and overlay types.                       |
| `NotificationParams`, `ShowNotification`                                                                                      | Screen and overlay types.                       |

**Modal handoff:** `modals.open(view, { signal, handoff })` can return a next view once the dialog is answered. That
view replaces it without closing it, with focus on the dialog so a second press cannot answer it at once.

### `@dotli/ui/testing`

Fakes for the specs and stories of other packages. Functional tests use them too. Never imported by shipped code.

| Export                                            | What it does                                       |
| ------------------------------------------------- | -------------------------------------------------- |
| `shownModal`, `chooseModalButton`, `dismissModal` | Answer the page's dialogs.                         |
| `PHONE_QUERY`                                     | The phone viewport query.                          |
| `settle`                                          | Flushes Solid's batched writes.                    |
| `appears`, `byId`, `byTestId`, `query`            | Page queries.                                      |
| `installPopoverPolyfill`                          | Popover support for functional tests on happy-dom. |

### `@dotli/ui/brand`

`Logo` draws the Polkadot logo. Its `variant` picks the symbol alone (`symbol`) or the symbol with the word (`full`),
and its `height` is the symbol's height in pixels. The full logo reads as "Polkadot" to assistive technology, and the
symbol alone is hidden from it. Its `beta` flag draws the Beta tag out of the flow, where the variant puts it: over the
end of the word, or just past the symbol's top-right corner. Its root wraps the drawing and takes the caller's `class`
and test id, so a height set there sizes the whole logo.

`PetalMark` draws six petals that can `pulse`. Astro renders the brand marks at build time with no directive, so they
ship no code there.

### `@dotli/ui/icons`

One component per icon, named `<Thing>Icon` (`CloseIcon`, `InfoIcon` and the rest), and `IconProps`. No stylesheet.

### `@dotli/ui/styles.css`

The tokens and global styles. The apps import it once.

It carries the brand typeface, which the build bundles and serves from the page's own origin. Sans text sets in it and
falls back to the system face while it loads or where it lacks a script. Monospace text keeps the system face.

## Design

- **Stores render, others act:** `toasts`, `modals` and `pageScreen` hold their state in an atom. The overlays render
  it. Everything else opens, pushes and settles through the stores.
- **Overlays mount late:** toasts and dialogs queue until the app mounts `Overlays`. Its container is marked
  `data-overlays`, so a full-page screen keeps it.
- **One layer stack:** floating layers share one stack. It makes the page inert under the top modal layer.
- **Placed at the trigger:** a floating layer anchored to a trigger opens below it when its content fits there, and
  otherwise on the side with more room. It stays on screen from side to side. It follows the trigger while open. It
  grows only as far as the visible area, the on-screen keyboard included, and scrolls inside past that.
- **Responsive popovers:** `Popover` and `DropdownMenu` anchor on a wide screen and become a bottom sheet on a phone.
  The sheet loads in its own chunk, preloaded when the browser is idle on a phone. Heavy content is the app's to load
  with `lazy()`. On a wide screen `DropdownMenu` is a `Listbox` hung from its button's end, which the button drives as a
  combobox while it keeps focus, and each item is an option. On a phone its items are menu rows in the sheet, which take
  focus, and the button is a menu button. The button's ARIA follows the viewport.
- **Responsive drawer:** `Drawer` is a modal panel inset from the right edge on a wide screen, and the standard bottom
  sheet on a phone. It picks the form by the viewport and follows it while open, and its content moves between the forms
  with its state and focus. Escape, a press on the scrim, its close button and a swipe toward its edge each close it.
  Its title is text or markup a heading may hold, and names the drawer. A text title also ends its close button's name.
  Its content mounts at each opening and stays until the exit transition ends, or goes at once when no transition runs,
  such as under reduced motion.
- **Listbox:** opens at its anchor in a floating layer, at least as wide as the anchor, and never takes focus, so the
  control that opened it keeps its keys. A press outside the anchor and the list, Escape and focus leaving them close it
  through `onClose`, and its caller sets `open` from that. A press on the anchor leaves it open. The caller also owns
  which option is active and which is chosen. A pick hands the caller its click, whose `detail` is 0 for a click from
  script. While `loading` holds a text, a status row with a spinner follows the options, outside the list, and the list
  is busy. A `Group` puts options in a section, a group named by its visible heading, and the caller leaves out an empty
  one. An option's `end` holds trailing markup after its text, such as a status and a chevron, which never shrinks, and
  the text ellipsizes before it. An option with `remove` ends in a cross that removes it without picking it. The cross
  is a plain element for mouse and touch only, out of the tab order and the accessibility tree, since an option may hold
  no interactive control. The option announces Shift+Delete, and the caller's key handling removes the active option on
  it.
- **Action group:** moves the lowest priority items into a More menu when they do not fit. Items join through
  `ActionsContext`.
- **Icons as components:** every `icon` prop takes a component, except in `Choice` and `SegmentedControl`, whose slot
  takes markup.
- **Text only:** the error page and the notifier take text, so nothing a visitor typed is parsed as markup.
- **Notifier:** always shows a toast. A hidden or unfocused tab also gets a system notification when allowed.
- **Keyboard pin:** `pinPageAboveKeyboard` takes a page box and the scroll box inside it, and returns its stop. While
  mobile Safari's keyboard is open for a field inside the page box, the box carries `data-keyboard-open`, and
  `--visible-height` and `--pan-offset` hold the visual viewport's height and offset. The page's CSS shifts and cuts the
  page by them, and the helper writes no other style. A drag in the page box that the scroll box cannot take is
  cancelled, and a tap in the page box outside any control blurs the field. A field outside the page box, such as an
  overlay's, gets none of this, and neither does a touch that starts outside it, such as a drag or a tap in a layer
  portaled out of the page. Once the keyboard closes, the page is back at its top, whichever field the keyboard was for,
  and after a pinned session the scroll box is too.
- **Root boundary:** a broken root is reported once and renders nothing. Mounted roots, floating layers and the apps'
  islands all use it.

Traps:

- `StepSlider` commits the picked stop even when it is the current one. Its owner decides what a repeat means.
- `Accordion` with `open` is controlled. A header press only reports the next state through `onToggle`.
- A disabled `SegmentedControl` keeps its options focusable, so a popover around it stays open.
