# `@dotli/ui-core`

Everything page startup may import from the UI: the page's roots, the toast and modal stores, the reporter types and
small page helpers. It imports no Solid, no JSX and no CSS, so both apps' boot paths take it at no cost.

## Responsibility

- Page roots: named roots that a replacement disposes, content roots that a full-page screen takes down, and the lazy
  root that loads a chunk and mounts it once.
- The toast and modal stores, where everything that decides how a toast or dialog settles lives.
- The reporter types that ui and its callers report recovered failures through.
- Page helpers: the controls Tab reaches, idle preload, the phone viewport, reduced motion and the status tones.
- Not owned: rendering. The Solid components, the mount, the overlays root, the toast view and the dialog that renders
  the modal queue live elsewhere.

## Design

- A toast or dialog carries its icon as a component. The store types it without Solid, as a function of a size, and the
  view that renders the store draws it.
- The stores are sync stores built on `createSyncStore`. The overlays render their state and everyone else opens, pushes
  and settles through them. A toast's countdown pauses while the tab is hidden or the stack is expanded.
- Roots have a lifecycle. `registerAppRoot` keeps named roots so a replacement disposes the old one, and a disposer that
  throws is reported, never rethrown, so an error page still renders. `createLazyRoot` mounts its chunk once on a
  `createAsyncTaskPool`, however often it is asked, and retries on the next call after a failure.
- Failures go out through the `Reporter` or `ReportFailure` the caller passes in. The package names no metrics package.
- Eslint refuses Solid, JSX and CSS, for dynamic imports too. The apps' boot bans point here, so a boot module never
  names a Solid component or its stylesheet.

## Public API

### `@dotli/ui-core`

- Reporting: the types `Reporter`, `ReportFailure`, `ReportExpected`, `FailureContext` and `ExpectedContext`.
- Roots: `registerAppRoot` (a root marked as content is the page's own) with `AppRootOptions`, `disposeAppRoot`,
  `disposeContentRoots`, `createLazyRoot`.
- Modal store: `openModal`, `failAllModals` and the types `ModalView`, `ModalOptions`, `ModalOutcome`. For the dialog
  that renders the queue: `modalsStore`, `settleModal` and the types `ModalEntry`, `ModalButton`, `ModalButtonVariant`.
- Toast store: `pushToast`, `clearToasts`, `toastsStore` and `ToastInput`. For the toast view: `dismissToast`,
  `removeToast`, `dismissAllToasts`, `setToastsExpanded` and `ToastEntry`.
- Focus: `focusables`.
- Helpers: `preloadWhenIdle` with `IdleScheduler`, `isPhoneViewport`, `watchPhoneViewport`, `prefersReducedMotion`.
- Types: `StatusTone`, and `IconComponent` for the icon a toast or dialog carries.

### `@dotli/ui-core/testing`

Fakes for other packages' specs, stories and functional tests. Never imported by shipped code.

- Modal store: `modalsStore`, `resetModalsForTests`, `shownModal`, `chooseModalButton`, `dismissModal`.
- Toasts: `bindToastPage`, `resetToastsForTests`.
- Viewport: `PHONE_QUERY`, `resetPhoneViewport`.
- Reporting: `createRecordingReporter` and `RecordingReporter`.
